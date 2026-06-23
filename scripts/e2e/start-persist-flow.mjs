// Drives the full start-and-persist flow: pick a ticket, configure the
// slipstream repo, start the agent (spawns real claude), close the app,
// reopen and verify the session persisted.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shot = (win, name) => win.screenshot({ path: `/tmp/e2e-${name}.png` })

const launch = () => electron.launch({ executablePath: electronPath, args: [root] })

// Phase 1 — create from ticket, pick slipstream repo, start
let app = await launch()
let win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)

console.log('sessions:', JSON.stringify(await win.evaluate(() => window.slipstream.listSessions())))
console.log('repos:', JSON.stringify(await win.evaluate(() => window.slipstream.listRepos())))

await win.getByRole('button', { name: /new agent/i }).click()
await win.waitForTimeout(800)

const tks = win.locator('.ticket-pick button.tk')
const n = await tks.count()
console.log('ticket buttons found:', n)
if (n !== 1) {
  console.log(`FAIL: expected exactly 1 ticket, got ${n}`)
  await shot(win, 'start-fail')
  await app.close()
  process.exit(1)
}

await tks.first().click()
await win.waitForTimeout(300)

await win.getByRole('button', { name: /create agent/i }).click()
await win.waitForTimeout(600)

await win.locator('#cfgRepoSel .sel-trigger').click()
await win.waitForTimeout(200)

try {
  await win.locator('#cfgRepoSel .opt', { hasText: 'slipstream' }).click()
} catch {
  console.log('FAIL: slipstream repo option not found')
  await shot(win, 'start-fail')
  await app.close()
  process.exit(1)
}
await win.waitForTimeout(200)

await shot(win, 'start-1-configured')

await win.getByRole('button', { name: /start agent/i }).click()

let found = false
for (let i = 0; i < 30; i++) {
  await win.waitForTimeout(1000)
  const ss = await win.evaluate(() => window.slipstream.listSessions())
  if (ss.length >= 1) {
    console.log('session:', JSON.stringify(ss))
    found = true
    break
  }
}
if (!found) {
  console.log('WARNING: session not found after 30s')
}

await win.waitForTimeout(2000)
await shot(win, 'start-2-running')

await app.close()

// Phase 2 — reopen, verify persistence
app = await launch()
win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)

const persisted = await win.evaluate(() => window.slipstream.listSessions())
console.log('persisted sessions:', JSON.stringify(persisted))

await shot(win, 'start-3-after-restart')

await app.close()

if (persisted.length >= 1) {
  console.log(`PASS: agent persisted (${persisted[0].tid})`)
} else {
  console.log('FAIL: no persisted session')
}
