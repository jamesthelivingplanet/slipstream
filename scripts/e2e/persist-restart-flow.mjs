// Verifies agents persist across an app restart.
//   Instance 1: register a throwaway repo, start an agent (spawns claude in an
//   isolated /tmp worktree), screenshot, then close — killing the PTY.
//   Instance 2: relaunch with the same --user-data-dir. initFromBackend() loads
//   the persisted session from the DB and it reappears as a detached card.
// Everything lives under /tmp so no real repo or data dir is touched.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const userDataDir = '/tmp/slipstream-e2e-persist'
const repoDir = '/tmp/slipstream-e2e-persist-repo'
const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-persist-${name}.png` })

// Fresh, isolated state.
fs.rmSync(userDataDir, { recursive: true, force: true })
fs.rmSync(repoDir, { recursive: true, force: true })
fs.mkdirSync(repoDir, { recursive: true })
const git = (...a) =>
  execFileSync('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
    stdio: 'pipe',
  })
git('init', '-b', 'main')
fs.writeFileSync(path.join(repoDir, 'README.md'), '# persist demo\n')
git('add', '.')
git('commit', '-m', 'init')

const launch = () =>
  electron.launch({
    executablePath: electronPath,
    args: [root, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SLIPSTREAM_DAEMON_EPHEMERAL: '1' },
  })

// ── Instance 1: start an agent ──────────────────────────────────────────────
let app = await launch()
let win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)

const repo = await win.evaluate((p) => window.slipstream.registerRepo(p), repoDir)
console.log('registered repo:', JSON.stringify(repo))
const dto = await win.evaluate(
  (rid) =>
    window.slipstream.startSession({
      tid: 'TASK-PERSIST',
      title: 'Persisted agent demo',
      prompt: 'print a short hello',
      repoId: rid,
    }),
  repo.id,
)
console.log('started session:', JSON.stringify(dto))
await win.waitForTimeout(1500)
await shot(win, '1-started')
await app.close() // kills the claude PTY — simulates closing the app

// ── Instance 2: relaunch, expect the session to persist ─────────────────────
app = await launch()
win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)
const persisted = await win.evaluate(() => window.slipstream.listSessions())
console.log('persisted after restart:', JSON.stringify(persisted))
await shot(win, '2-after-restart')
await app.close()

console.log(
  persisted.length === 1 ? 'PASS: session survived restart' : 'FAIL: expected 1 persisted session',
)
