/**
 * daemon-survival-flow.mjs
 *
 * Verifies that the local daemon SURVIVES app close and the same port is
 * reused on relaunch (daemon.json persists across instances).
 *
 * Does NOT set SLIPSTREAM_DAEMON_EPHEMERAL so the daemon lives past app.close().
 * Does NOT spawn a real claude agent.
 *
 * Usage: node scripts/e2e/daemon-survival-flow.mjs
 * Requires: pnpm build has been run; a display is available.
 *
 * NOTE: This driver intentionally leaves one daemon running when it exits.
 * It prints the PID and port of the surviving daemon so you can kill it if
 * needed (e.g. `kill <pid>` or `fuser -k <port>/tcp`).
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const userDataDir = '/tmp/slipstream-e2e-daemon-survival'

// Fresh isolated state for a clean first run
fs.rmSync(userDataDir, { recursive: true, force: true })
fs.mkdirSync(userDataDir, { recursive: true })

function healthz(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 1000 }, (res) => {
      resolve(res.statusCode === 200)
      res.resume()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function pollHealthy(port, maxMs = 5000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await healthz(port)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

// ── Launch 1: get the daemon port ─────────────────────────────────────────────
console.log('Launch 1: starting app...')
let app = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
  // NO SLIPSTREAM_DAEMON_EPHEMERAL — daemon must survive
})

let win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2000)

const daemonInfo = await win.evaluate(() => window.__slipstreamDaemon)
console.log('daemon info from renderer:', JSON.stringify(daemonInfo))

if (!daemonInfo?.url) {
  console.log('FAIL: window.__slipstreamDaemon not set')
  await app.close()
  process.exit(1)
}

// Extract port from the ws URL, e.g. ws://127.0.0.1:7421/rpc
const portMatch = daemonInfo.url.match(/:(\d+)\//)
if (!portMatch) {
  console.log('FAIL: could not extract port from', daemonInfo.url)
  await app.close()
  process.exit(1)
}
const port = Number(portMatch[1])
console.log('daemon port:', port)

const hasBridge = await win.evaluate(() => !!window.slipstream)
console.log('window.slipstream present:', hasBridge)

await app.close()
console.log('App closed. Checking if daemon survived...')

// ── Poll /healthz after close ─────────────────────────────────────────────────
const survived = await pollHealthy(port, 5000)
if (!survived) {
  console.log('FAIL: daemon did not survive app close')
  process.exit(1)
}
console.log('PASS: daemon is still running after app close')

// ── Launch 2: reuse the same user-data-dir ────────────────────────────────────
console.log('Launch 2: relaunching with same user-data-dir...')
app = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
})

win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2000)

const daemonInfo2 = await win.evaluate(() => window.__slipstreamDaemon)
const portMatch2 = daemonInfo2?.url?.match(/:(\d+)\//)
const port2 = portMatch2 ? Number(portMatch2[1]) : null
console.log('daemon port on relaunch:', port2)

if (port2 !== port) {
  console.log(`FAIL: expected same port ${port} on relaunch, got ${port2}`)
  await app.close()
  process.exit(1)
}
console.log('PASS: same port reused (daemon.json persisted)')

// ── Verify listSessions callable ──────────────────────────────────────────────
const sessions = await win.evaluate(() => window.slipstream.listSessions())
console.log('listSessions():', JSON.stringify(sessions))
console.log('PASS: listSessions callable via WS API')

await app.close()

console.log(`
NOTE: A daemon process is still running on port ${port}.
To stop it: fuser -k ${port}/tcp  (Linux)  or  kill $(lsof -ti:${port})
`)
console.log('PASS: daemon-survival-flow complete')
