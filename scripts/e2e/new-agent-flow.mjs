// Drives the freeform "blank agent" flow (no mock tickets): open New agent,
// type a title + prompt, pick a repo, and start the agent. Requires a registered repo.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const userDataDir = '/tmp/slipstream-e2e-newagent'
const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-${name}.png` })

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, SLIPSTREAM_DAEMON_EPHEMERAL: '1' },
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)

console.log('tickets:', JSON.stringify(await win.evaluate(() => window.slipstream.listTickets())))
await shot(win, 'n1-home')

await win.getByRole('button', { name: /new agent/i }).click()
await win.waitForTimeout(400)
await shot(win, 'n2-dialog')

await win.locator('#dTitle').fill('Investigate slow cold start')
await win.locator('#dPrompt').fill('Profile the app boot and cut cold-start time.')
await win.waitForTimeout(200)

// Repo selection now lives in the New agent dialog (FLO-34).
await win.locator('#dlgRepoSel .sel-trigger').click()
await win.waitForTimeout(200)
await win.locator('#dlgRepoSel .sel-menu .opt').first().click()
await win.waitForTimeout(200)
await shot(win, 'n3-filled')

// NOTE: this now starts a real `claude` in a fresh worktree (see CLAUDE.md e2e warning).
await win.getByRole('button', { name: /start agent/i }).click()
await win.waitForTimeout(600)
await shot(win, 'n4-started')

console.log('sessions:', JSON.stringify(await win.evaluate(() => window.slipstream.listRepos())))
await app.close()
console.log('done')
