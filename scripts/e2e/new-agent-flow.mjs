// Drives the freeform "blank agent" flow (no mock tickets): open New agent,
// type a title + prompt, create, and confirm it lands as an idle agent.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const userDataDir = '/tmp/flotilla-e2e-newagent'
const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-${name}.png` })

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1000)

console.log('tickets:', JSON.stringify(await win.evaluate(() => window.flotilla.listTickets())))
await shot(win, 'n1-home')

await win.getByRole('button', { name: /new agent/i }).click()
await win.waitForTimeout(400)
await shot(win, 'n2-dialog')

await win.locator('#dTitle').fill('Investigate slow cold start')
await win.locator('#dPrompt').fill('Profile the app boot and cut cold-start time.')
await win.waitForTimeout(200)
await shot(win, 'n3-filled')

await win.getByRole('button', { name: /create agent/i }).click()
await win.waitForTimeout(600)
await shot(win, 'n4-created')

console.log('sessions:', JSON.stringify(await win.evaluate(() => window.flotilla.listRepos())))
await app.close()
console.log('done')
