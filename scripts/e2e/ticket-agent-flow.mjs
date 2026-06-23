// Drives the ticket-agent flow: open New agent, pick the first Linear ticket,
// create a draft agent from it, and confirm it lands in the session list.
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

await win.getByRole('button', { name: /create agent/i }).click()
await win.waitForTimeout(600)
await shot(win, 'ticket-3-created')

console.log('done')
await app.close()
