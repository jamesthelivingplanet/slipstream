import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { openDb } from './db/db.js'
import { createRepoRegistry } from './services/repoRegistry.js'
import { createWorktreeManager } from './services/worktreeManager.js'
import { createSessionManager } from './services/sessionManager.js'
import { createPortBroker } from './services/portBroker.js'
import { createMockProvider } from './tickets/mockProvider.js'
import { registerIpc } from './ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// dist-electron/  (this file)  →  project root
process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#09090b',
    title: 'Flotilla',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // ESM (.mjs) preload scripts require the sandbox to be disabled; otherwise
      // the preload silently fails to load and window.flotilla is never exposed.
      sandbox: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // ── wire the backend services and expose them over IPC ──
  const root = app.getPath('userData')
  const db = openDb(path.join(root, 'flotilla.db'))
  registerIpc(win, {
    repos: createRepoRegistry(db, root),
    worktrees: createWorktreeManager(root),
    sessions: createSessionManager(),
    ports: createPortBroker(),
    tickets: createMockProvider(),
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
