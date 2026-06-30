import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveDaemonConfig, ensureLocalDaemon } from './core/daemonManager.js'
import type { DaemonConfig, DaemonHandle } from './core/daemonManager.js'
import { IPC } from './shared/contract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let win: BrowserWindow | null = null
let daemonHandle: DaemonHandle | null = null
let resolvedCfg: DaemonConfig | null = null

function createWindow(cfg: DaemonConfig): void {
  const daemonArg =
    '--slipstream-daemon=' +
    Buffer.from(JSON.stringify({ url: cfg.wsUrl, token: cfg.token })).toString('base64')

  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#09090b',
    title: 'Slipstream',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      sandbox: false,
      additionalArguments: [daemonArg],
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

ipcMain.handle(IPC.pickRepo, async () => {
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a repository',
    properties: ['openDirectory'],
  })
  return res.canceled ? null : (res.filePaths[0] ?? null)
})

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  const ephemeral = process.env.SLIPSTREAM_DAEMON_EPHEMERAL === '1'

  try {
    resolvedCfg = await resolveDaemonConfig({ env: process.env, dataDir })
  } catch (err) {
    console.error('[slipstream] Failed to resolve daemon config:', err)
    resolvedCfg = {
      mode: 'local',
      wsUrl: 'ws://127.0.0.1:7421/rpc',
      httpBase: 'http://127.0.0.1:7421',
      token: 'error',
      port: 7421,
    }
  }

  if (resolvedCfg.mode === 'local') {
    try {
      daemonHandle = await ensureLocalDaemon(resolvedCfg, {
        serverEntry: path.join(__dirname, 'server.js'),
        dataDir,
        ephemeral,
      })
      console.log(
        `[slipstream] daemon ${daemonHandle.reused ? 'reused' : 'spawned'} at ${resolvedCfg.httpBase}`,
      )
    } catch (err) {
      console.error('[slipstream] Failed to start local daemon:', err)
    }
  }

  createWindow(resolvedCfg)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('before-quit', () => {
  const ephemeral = process.env.SLIPSTREAM_DAEMON_EPHEMERAL === '1'
  if (ephemeral && daemonHandle?.child) {
    daemonHandle.kill()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && resolvedCfg) {
    createWindow(resolvedCfg)
  }
})
