import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveDaemonConfig, ensureLocalDaemon } from './core/daemonManager.js'
import type { DaemonConfig, DaemonHandle } from './core/daemonManager.js'
import { runBootstrap, renderDaemonErrorPage, daemonErrorMessage } from './core/bootstrap.js'
import type { BootstrapDeps, BootOutcome } from './core/bootstrap.js'
import { IPC } from './shared/contract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let win: BrowserWindow | null = null
let daemonHandle: DaemonHandle | null = null
let resolvedCfg: DaemonConfig | null = null
let resolvedReused = false

function createWindow(cfg: DaemonConfig, reused: boolean): void {
  const daemonArg =
    '--slipstream-daemon=' +
    Buffer.from(JSON.stringify({ url: cfg.wsUrl, token: cfg.token, reused })).toString('base64')

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

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createErrorWindow(outcome: Extract<BootOutcome, { ok: false }>): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#09090b',
    title: 'Slipstream',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
    },
  })

  const html = renderDaemonErrorPage(outcome)
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
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

  const deps: BootstrapDeps = {
    resolveConfig: () => resolveDaemonConfig({ env: process.env, dataDir }),
    ensureDaemon: async (cfg) => {
      daemonHandle = await ensureLocalDaemon(cfg, {
        serverEntry: path.join(__dirname, 'server.js'),
        dataDir,
        ephemeral,
      })
      console.log(
        `[slipstream] daemon ${daemonHandle.reused ? 'reused' : 'spawned'} at ${cfg.httpBase}`,
      )
      return daemonHandle
    },
    showApp: (cfg) => {
      resolvedCfg = cfg
      resolvedReused = daemonHandle?.reused ?? false
      createWindow(cfg, resolvedReused)
    },
    showError: (outcome) => {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      console.error(`[slipstream] boot failed (${outcome.stage}):`, outcome.error)
      // Blocking dialog so the failure is impossible to miss...
      dialog.showErrorBox(
        'Slipstream could not start',
        `${daemonErrorMessage(outcome.stage)}\n\n${detail}\n\nSee CLAUDE.md → Troubleshooting native setup, or check <data dir>/logs/server.log.`,
      )
      createErrorWindow(outcome)
    },
  }

  await runBootstrap(deps)
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
    // A relaunch here always reattaches to the already-running daemon from
    // this app session, so it's a reuse from the renderer's perspective.
    createWindow(resolvedCfg, true)
  }
})
