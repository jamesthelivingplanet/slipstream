// Drives the ticket-agent flow: open New agent, pick the first Linear ticket,
// pick a repo, and start the agent. Requires a registered repo.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-${name}.png` })

const app = await electron.launch({
  executablePath: electronPath,
  args: [root],
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)

console.log('tickets:', JSON.stringify(await win.evaluate(() => window.slipstream.listTickets())))

await win.getByRole('button', { name: /new agent/i }).click()
await win.waitForTimeout(800)
await shot(win, 'ticket-1-dialog')

const tks = win.locator('.ticket-pick button.tk')
const n = await tks.count()
console.log('ticket buttons found:', n)
if (n !== 1) {
  console.log(`FAIL: expected exactly 1 ticket, got ${n}`)
  await shot(win, 'ticket-fail')
  await app.close()
  process.exit(1)
}

await tks.first().click()
await win.waitForTimeout(300)
await shot(win, 'ticket-2-picked')

// Repo selection now lives in the New agent dialog (FLO-34).
await win.locator('#dlgRepoSel .sel-trigger').click()
await win.waitForTimeout(200)
await win.locator('#dlgRepoSel .sel-menu .opt').first().click()
await win.waitForTimeout(200)

// NOTE: this now starts a real `claude` (see CLAUDE.md e2e warning).
await win.getByRole('button', { name: /start agent/i }).click()
await win.waitForTimeout(600)
await shot(win, 'ticket-3-started')

console.log('done')
await app.close()
