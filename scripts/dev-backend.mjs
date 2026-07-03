#!/usr/bin/env node
/**
 * Standard backend dev loop: rebuild → kill-by-port → respawn.
 *
 * `pnpm dev` builds dist-electron/server.js once, up front, and does not
 * hot-reload it — Vite hot-reloads the renderer and restarts `main`, but a
 * restarted `main` just reuses the already-running local daemon (found via
 * /healthz). So edits to `server.ts` or any `electron/services/*` /
 * `electron/core/*` code the daemon runs won't take effect until the daemon
 * is rebuilt and restarted. This script does that in one step. See the
 * "`pnpm dev` builds `server.js` once" gotcha in CLAUDE.md.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(scriptDir)

function resolveDataDir() {
  if (process.env.SLIPSTREAM_DATA_DIR) return process.env.SLIPSTREAM_DATA_DIR

  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'slipstream')
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'slipstream',
      )
    default:
      // Linux / XDG
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'slipstream',
      )
  }
}

function isHealthy(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${port}/healthz`
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        done(res.statusCode === 200)
        res.resume()
      })
      req.on('error', () => done(false))
      req.on('timeout', () => {
        req.destroy()
        done(false)
      })
      setTimeout(() => done(false), timeoutMs + 100)
    } catch {
      done(false)
    }
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntil(port, wantHealthy, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const healthy = await isHealthy(port)
    if (healthy === wantHealthy) return true
    await sleep(intervalMs)
  }
  return (await isHealthy(port)) === wantHealthy
}

async function killByPort(port) {
  if (!(await isHealthy(port))) {
    console.log(`no daemon currently listening on port ${port}`)
    return
  }

  if (process.platform === 'linux') {
    try {
      execFileSync('fuser', ['-k', '-TERM', `${port}/tcp`], { stdio: 'ignore' })
    } catch {
      // fuser may be absent
    }
  } else if (process.platform === 'darwin') {
    try {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`]).toString()
      for (const pid of out.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch {
          // process may already be gone
        }
      }
    } catch {
      // lsof may be absent or find nothing
    }
  }

  const downAfterTerm = await pollUntil(port, false, 5000)

  if (!downAfterTerm) {
    if (process.platform === 'linux') {
      try {
        execFileSync('fuser', ['-k', '-KILL', `${port}/tcp`], { stdio: 'ignore' })
      } catch {
        // fuser may be absent
      }
    } else if (process.platform === 'darwin') {
      try {
        const out = execFileSync('lsof', ['-ti', `tcp:${port}`]).toString()
        for (const pid of out.split('\n').filter(Boolean)) {
          try {
            process.kill(Number(pid), 'SIGKILL')
          } catch {
            // process may already be gone
          }
        }
      } catch {
        // lsof may be absent or find nothing
      }
    }
    const downAfterKill = await pollUntil(port, false, 2000)
    if (downAfterKill) {
      console.log(`killed daemon on port ${port}`)
    } else {
      console.log(`daemon on port ${port} did not confirm down — proceeding anyway`)
    }
  } else {
    console.log(`killed daemon on port ${port}`)
  }
}

async function main() {
  console.log('==> rebuilding dist-electron/server.js')
  execFileSync(process.execPath, [path.join(root, 'scripts/build-server.mjs')], {
    stdio: 'inherit',
    cwd: root,
  })

  const dataDir = resolveDataDir()
  const daemonJsonPath = path.join(dataDir, 'daemon.json')

  let daemonInfo
  try {
    const raw = fs.readFileSync(daemonJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.token === 'string' && typeof parsed.port === 'number') {
      daemonInfo = parsed
    }
  } catch {
    // missing or unreadable
  }

  if (!daemonInfo) {
    console.log(
      `No daemon.json found at ${daemonJsonPath} — start \`pnpm dev\` once to create the local daemon, then re-run \`pnpm dev:backend\`.`,
    )
    process.exit(0)
  }

  const { port, token } = daemonInfo

  console.log(`==> stopping daemon on port ${port}`)
  await killByPort(port)

  console.log('==> respawning daemon')
  const electronBin = require('electron')
  const serverEntry = path.join(root, 'dist-electron/server.js')

  const child = spawn(electronBin, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SLIPSTREAM_TOKEN: token,
      SLIPSTREAM_PORT: String(port),
      SLIPSTREAM_BIND: '127.0.0.1',
      SLIPSTREAM_DATA_DIR: dataDir,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const up = await pollUntil(port, true, 15000)
  if (up) {
    console.log(
      `✓ daemon respawned on port ${port} — backend changes are now live (reload the app window if open)`,
    )
  } else {
    console.error(`daemon did not become healthy on port ${port} within 15s`)
    process.exit(1)
  }
}

await main()
