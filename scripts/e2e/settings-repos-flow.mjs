// Drives the Settings > Repositories flow: open settings, add a valid repo
// (success toast), attempt a non-git folder (error toast), then remove a repo.
// Native dialog is stubbed. Screenshots each step to /tmp.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const userDataDir = '/tmp/flotilla-e2e-settings'
const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-${name}.png` })
const stubDialog = (app, p) =>
  app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, p)

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1000)
await shot(win, 's1-home')

// open Settings (gear is the icon button directly in the header bar)
await win.locator('.bar > button.btn-icon').click()
await win.waitForTimeout(400)
await shot(win, 's2-settings-empty')

// success: a real git repo (this project)
await stubDialog(app, root)
await win.getByRole('button', { name: /add repository/i }).click()
await win.waitForTimeout(700)
console.log('repos:', JSON.stringify(await win.evaluate(() => window.flotilla.listRepos())))
await shot(win, 's3-repo-added')

// error: a non-git folder
await stubDialog(app, '/tmp')
await win.getByRole('button', { name: /add repository/i }).click()
await win.waitForTimeout(700)
await shot(win, 's4-error-toast')

// remove the repo
await win.locator('.repo-row button[title="Remove repository"]').first().click()
await win.waitForTimeout(600)
console.log('repos after remove:', JSON.stringify(await win.evaluate(() => window.flotilla.listRepos())))
await shot(win, 's5-after-remove')

await app.close()
console.log('done')
