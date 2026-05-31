// Drives the built Electron app via Playwright to exercise the Add-repo flow.
// The native folder dialog is stubbed to return a real git repo path, so no
// OS picker interaction is needed. Stops before "Start agent" so it never
// spawns an autonomous claude. Screenshots each step to /tmp.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoToAdd = root // the Flotilla repo itself is a real git repo
const userDataDir = '/tmp/flotilla-e2e'

const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-${name}.png` })

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
})

const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1000)

const hasBridge = await win.evaluate(() => !!window.flotilla)
console.log('window.flotilla present:', hasBridge)

const reposBefore = await win.evaluate(() => window.flotilla.listRepos())
console.log('repos before:', JSON.stringify(reposBefore))
await shot(win, '1-home')

// Stub the native open dialog to return our repo path.
await app.evaluate(async ({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
}, repoToAdd)

await win.getByRole('button', { name: /add repo/i }).click()
await win.waitForTimeout(1200)

const reposAfter = await win.evaluate(() => window.flotilla.listRepos())
console.log('repos after add:', JSON.stringify(reposAfter))
await shot(win, '2-after-add')

// Walk into the New-agent flow to show the registered repo in the dropdown.
await win.getByRole('button', { name: /new agent/i }).click()
await win.waitForTimeout(500)
await shot(win, '3-new-agent-dialog')

const ticketCount = await win.locator('.tk').count()
console.log('tickets in dialog:', ticketCount)
if (ticketCount > 0) {
  await win.locator('.tk').first().click()
  await win.getByRole('button', { name: /create agent/i }).click()
  await win.waitForTimeout(600)
  await shot(win, '4-config')

  // Open the repo dropdown to reveal registered repos.
  await win.locator('.sel-trigger').first().click()
  await win.waitForTimeout(400)
  await shot(win, '5-repo-dropdown')
}

await app.close()
console.log('done')
