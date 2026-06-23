import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { registerIpc } from './ipc.js'
import { createServices } from './core/services.js'
import type { IpcDeps } from './ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// dist-electron/  (this file)  →  project root
process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let win: BrowserWindow | null = null
let services: IpcDeps | null = null

function createWindow() {
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
      // ESM (.mjs) preload scripts require the sandbox to be disabled; otherwise
      // the preload silently fails to load and window.slipstream is never exposed.
      sandbox: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // ── wire the backend services and expose them over IPC ──
  services = createServices(app.getPath('userData'))
  registerIpc(win, services)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('before-quit', () => {
  services?.sessions.killAll()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
