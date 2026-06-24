import { ipcMain, dialog, BrowserWindow } from 'electron'
import type {
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  ISessionStore,
} from './shared/contract.js'
import { IPC } from './shared/contract.js'
import { createRpc } from './core/rpc.js'
import type { IConfigStore } from './services/configStore.js'
import type { IEditorLauncher } from './services/editorLauncher.js'

export interface IpcDeps {
  repos: IRepoRegistry
  worktrees: IWorktreeManager
  sessions: ISessionManager
  ports: IPortBroker
  tickets: ITicketProvider
  config: IConfigStore
  sessionStore: ISessionStore
  editor: IEditorLauncher
}

/**
 * Register all IPC handlers for the renderer bridge.
 * Thin Electron adapter over the transport-free createRpc core.
 */
export function registerIpc(win: BrowserWindow, deps: IpcDeps): void {
  const rpc = createRpc(deps, (channel, ...args) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  })

  // ── Request channels (handle = invoke, returns a value) ────────────────────
  const requestChannels = [
    IPC.listRepos,
    IPC.registerRepo,
    IPC.removeRepo,
    IPC.listTickets,
    IPC.startSession,
    IPC.killSession,
    IPC.cleanupSession,
    IPC.listSessions,
    IPC.resumeSession,
    IPC.attachRemoteControl,
    IPC.getSessionBuffer,
    IPC.worktreeStatus,
    IPC.getLinearKey,
    IPC.setLinearKey,
    IPC.getEditorConfig,
    IPC.setEditorConfig,
    IPC.openInEditor,
    IPC.getTicketStatus,
    IPC.setTicketStatus,
  ] as const

  for (const channel of requestChannels) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => rpc.handle(channel, args))
  }

  // ── Fire-and-forget channels (on = send, no return value) ─────────────────
  ipcMain.on(IPC.writeSession, (_e, id: string, data: string) =>
    deps.sessions.write(id, data),
  )

  ipcMain.on(
    IPC.resizeSession,
    (_e, id: string, cols: number, rows: number) =>
      deps.sessions.resize(id, cols, rows),
  )

  // ── pickRepo: Electron-only — native folder dialog ─────────────────────────
  ipcMain.handle(IPC.pickRepo, async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a repository',
      properties: ['openDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return await deps.repos.register(res.filePaths[0])
  })
}
