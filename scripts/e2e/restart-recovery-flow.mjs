// Headless restart/crash-recovery e2e (FLO-135).
//
// Proves the daemon's restart-recovery contract end to end in CI — no display,
// no Electron window, no real claude:
//
//   1. Start the headless daemon (ELECTRON_RUN_AS_NODE server.js) with a stub
//      `claude` on PATH and an isolated data dir.
//   2. Drive the web UI with Playwright chromium (web mode): register a
//      throwaway repo, start a session. The stub claude emits a unique marker
//      and stays alive → the session is live + 'running' and its scrollback is
//      persisted to <dataDir>/scrollback/<id>.log (scrollbackStore.append,
//      synchronous per chunk).
//   3. Assert getSessionBuffer() contains the marker (scrollback captured).
//   4. SIGKILL the daemon — the PTY child dies with it (closing the PTY master
//      delivers SIGHUP to the session leader); the DB row stays 'running'.
//   5. Restart a fresh daemon against the SAME data dir. On boot
//      restoreInterruptedSessions() (sessionStore.ts) marks the orphaned
//      'running'/'needs' rows 'interrupted'.
//   6. Reload the page and assert listSessions() shows the session
//      'interrupted' AND getSessionBuffer() replays the persisted marker
//      (buffer replay off the scrollback file — sessionManager.getBuffer's
//      not-live fallback).
//
// This is the only CI path that exercises reconnect/replay/restart. The xvfb
// Electron smoke (smoke-add-repo.mjs) covers the preload bridge + add-repo UI;
// this one covers the recovery semantics the others only prove by hand. Exits
// nonzero on any failure so the CI job goes red.
//
// Run locally (after `pnpm build` + native rebuild for Electron):
//   pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty
//   node scripts/e2e/restart-recovery-flow.mjs
import { chromium } from 'playwright'
import electronPath from 'electron'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const serverEntry = path.join(root, 'dist-electron', 'server.js')
const TOKEN = 'e2e-restart-token'
// Baked into the stub `claude` so we can search the replayed scrollback for it.
const MARKER = `RESTART-E2E-MARKER-${randomUUID()}`

function fail(message) {
  console.error(`restart-recovery FAILED: ${message}`)
  process.exitCode = 1
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isHealthy(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: timeoutMs }, (res) => {
        done(res.statusCode === 200)
        res.resume()
      })
      req.on('error', () => done(false))
      req.on('timeout', () => {
        req.destroy()
        done(false)
      })
    } catch {
      done(false)
    }
  })
}

async function waitForDaemon(port, wantHealthy, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await isHealthy(port)) === wantHealthy) return true
    await sleep(200)
  }
  return (await isHealthy(port)) === wantHealthy
}

/** Poll `fn` until it returns truthy or the deadline lapses. */
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(200)
  }
  return false
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function spawnDaemon({ port, dataDir, stubDir }) {
  const child = spawn(electronPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SLIPSTREAM_TOKEN: TOKEN,
      SLIPSTREAM_PORT: String(port),
      SLIPSTREAM_BIND: '127.0.0.1',
      SLIPSTREAM_DATA_DIR: dataDir,
      // Put the stub `claude` ahead of everything so the claude-code backend
      // (which spawns CLAUDE_BIN='claude') resolves to OUR stub. PATH is
      // inherited by the agent PTY via buildAgentEnv (only daemon-internal
      // keys are stripped — PATH is preserved).
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `[daemon:${child.pid}]`
  child.stdout.on('data', (d) => process.stdout.write(`${prefix} ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`${prefix} ${d}`))
  child.on('exit', (code, signal) => {
    console.log(`${prefix} exited (code=${code} signal=${signal})`)
  })
  return child
}

// ── Fixture: isolated data dir, throwaway repo, stub `claude` on PATH ────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-e2e-restart-data-'))
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-e2e-restart-repo-'))
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-e2e-restart-bin-'))

function initRepo(dir) {
  const git = (...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      stdio: 'pipe',
    })
  git('init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# restart-recovery e2e\n')
  git('add', '.')
  git('commit', '-m', 'init')
}
initRepo(repoDir)
console.log('fixture repo:', repoDir)

// The stub emits the marker (captured into the persisted scrollback) and then
// blocks until the PTY master closes — daemon death delivers SIGHUP / stdin
// EOF, ending the process with no orphan. Args are accepted and ignored.
const stub = `#!/usr/bin/env node
// stub claude for FLO-135 restart-recovery e2e — auto-generated, do not edit.
const args = process.argv.slice(2).join(' ')
process.stdout.write(${JSON.stringify(MARKER)} + ' args=' + JSON.stringify(args) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 60000)
`
fs.writeFileSync(path.join(stubDir, 'claude'), stub, { mode: 0o755 })
fs.chmodSync(path.join(stubDir, 'claude'), 0o755)
console.log('stub claude:', path.join(stubDir, 'claude'))

let daemon
let browser
try {
  // ── 1. Start the headless daemon ──────────────────────────────────────────
  const port = await freePort()
  console.log(`starting daemon on port ${port} (data dir ${dataDir})`)
  daemon = spawnDaemon({ port, dataDir, stubDir })
  if (!(await waitForDaemon(port, true, 20_000))) {
    fail('daemon #1 did not become healthy')
    throw new Error('daemon #1 unhealthy')
  }
  console.log('daemon #1 healthy')

  // ── 2. Drive the web UI: register repo, start session ─────────────────────
  browser = await chromium.launch()
  const page = await browser.newPage()
  const url = `http://127.0.0.1:${port}/?token=${TOKEN}`
  await page.goto(url)
  await page.waitForFunction(() => !!window.slipstream, { timeout: 15_000 })
  console.log('web mode connected: window.slipstream ready')

  const repo = await page.evaluate((p) => window.slipstream.registerRepo(p), repoDir)
  console.log('registered repo:', JSON.stringify(repo))

  const session = await page.evaluate(
    (input) =>
      window.slipstream.startSession({
        tid: 'TASK-RESTART',
        title: 'Restart recovery e2e',
        prompt: 'emit the marker and idle',
        repoId: input.repoId,
      }),
    { repoId: repo.id },
  )
  console.log('started session:', JSON.stringify(session))
  const sessionId = session.id

  // ── 3. Wait for the stub's marker to land in the persisted scrollback ─────
  const markerSeen = await waitFor(async () => {
    const buf = await page.evaluate((id) => window.slipstream.getSessionBuffer(id), sessionId)
    return buf?.data?.includes(MARKER) === true
  }, 15_000)
  if (!markerSeen) {
    fail('marker never appeared in getSessionBuffer before kill')
    throw new Error('marker-missing')
  }
  console.log('marker captured in scrollback before kill')

  const beforeKill = await page.evaluate(
    async (id) => (await window.slipstream.listSessions()).find((s) => s.id === id),
    sessionId,
  )
  console.log('session status before kill:', beforeKill?.status)
  if (beforeKill?.status === 'interrupted') {
    fail(`session was already 'interrupted' before the kill (expected running/needs)`)
  }

  // ── 4. SIGKILL the daemon — PTY dies with it, DB row stays 'running' ──────
  console.log(`SIGKILL daemon #1 (pid ${daemon.pid})`)
  const killedPid = daemon.pid
  try {
    process.kill(killedPid, 'SIGKILL')
  } catch {
    // already gone
  }
  // Wait until the WS drops / healthz goes false; stop referencing the dead child.
  await waitForDaemon(port, false, 10_000)
  daemon = undefined
  // Give the OS a moment to fully release the listening socket so the respawn
  // doesn't race EADDRINUSE.
  await sleep(500)

  // ── 5. Restart a fresh daemon against the SAME data dir ───────────────────
  daemon = spawnDaemon({ port, dataDir, stubDir })
  if (!(await waitForDaemon(port, true, 20_000))) {
    fail('daemon #2 did not become healthy after restart')
    throw new Error('daemon #2 unhealthy')
  }
  console.log('daemon #2 healthy (restart complete)')

  // ── 6. Reload + assert interrupted + buffer replay ────────────────────────
  await page.goto(url)
  await page.waitForFunction(() => !!window.slipstream, { timeout: 15_000 })

  const afterRestart = await page.evaluate(
    async (id) => (await window.slipstream.listSessions()).find((s) => s.id === id),
    sessionId,
  )
  console.log('session status after restart:', afterRestart?.status)
  if (afterRestart?.status !== 'interrupted') {
    fail(
      `expected session 'interrupted' after restart, got '${afterRestart?.status}' ` +
        `(restoreInterruptedSessions did not mark the orphaned row)`,
    )
  }

  const replayed = await page.evaluate((id) => window.slipstream.getSessionBuffer(id), sessionId)
  console.log(
    'replayed buffer seq:',
    replayed?.seq,
    'marker present:',
    replayed?.data?.includes(MARKER),
  )
  if (!replayed?.data?.includes(MARKER)) {
    fail('buffer replay did not contain the persisted marker after restart')
  }

  if (!process.exitCode) {
    console.log('restart-recovery ok')
  }
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (daemon) {
    try {
      process.kill(daemon.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  // Best-effort fixture cleanup. Worktrees live under ~/.worktrees (not the
  // data dir) and are left in place — same as the other e2e drivers; the CI
  // container is ephemeral.
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(repoDir, { recursive: true, force: true })
  fs.rmSync(stubDir, { recursive: true, force: true })
}

if (process.exitCode) {
  process.exit(process.exitCode)
}
