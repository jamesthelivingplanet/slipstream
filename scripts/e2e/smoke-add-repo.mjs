// CI-friendly smoke driver: launches the built Electron app, verifies the
// preload bridge (window.slipstream) is present (catches the "silent no-op
// bridge" regression class — see CLAUDE.md § CJS preload), adds a repo via
// the stubbed native folder dialog, and asserts the repo count increased.
//
// Unlike the other scripts/e2e/*.mjs drivers (which are manual/local and
// screenshot each step), this one is meant to run unattended in CI under
// xvfb: no screenshots, a single pass/fail assertion chain, and a nonzero
// exit code on any failure so the job goes red.
//
// Never drives "Start agent" — it must not spawn a real claude process.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoToAdd = root // the Slipstream repo itself is a real git repo
const userDataDir = mkdtempSync(path.join(tmpdir(), 'slipstream-e2e-smoke-'))

function fail(message) {
  console.error(`smoke FAILED: ${message}`)
  process.exitCode = 1
}

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SLIPSTREAM_DAEMON_EPHEMERAL: '1' },
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1500)

  const hasBridge = await win.evaluate(() => !!window.slipstream)
  if (!hasBridge) {
    fail(
      'window.slipstream is not present — preload bridge did not load (see CLAUDE.md § CJS preload)',
    )
  } else {
    console.log('window.slipstream present: true')
  }

  if (!process.exitCode) {
    const reposBefore = await win.evaluate(() => window.slipstream.listRepos())
    const countBefore = Array.isArray(reposBefore) ? reposBefore.length : 0
    console.log('repos before:', countBefore)

    // Stub the native open dialog to return our repo path.
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, repoToAdd)

    await win.getByRole('button', { name: /add repo/i }).click()
    await win.waitForTimeout(1200)

    const reposAfter = await win.evaluate(() => window.slipstream.listRepos())
    const countAfter = Array.isArray(reposAfter) ? reposAfter.length : 0
    console.log('repos after add:', countAfter)

    if (countAfter <= countBefore) {
      fail(`repo count did not increase (before=${countBefore}, after=${countAfter})`)
    }
  }
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err))
} finally {
  if (app) {
    await app.close()
  }
}

if (process.exitCode) {
  process.exit(process.exitCode)
}

console.log('smoke ok')
process.exit(0)
