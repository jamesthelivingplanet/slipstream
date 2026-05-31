import { contextBridge, ipcRenderer } from 'electron'
import type { FlotillaApi, SessionStatus } from './shared/contract.js'
import { IPC } from './shared/contract.js'

const api: FlotillaApi = {
  // ── Repos ────────────────────────────────────────────────────────────────
  listRepos: () => ipcRenderer.invoke(IPC.listRepos),
  registerRepo: (absPath) => ipcRenderer.invoke(IPC.registerRepo, absPath),
  pickAndRegisterRepo: () => ipcRenderer.invoke(IPC.pickRepo),
  removeRepo: (id) => ipcRenderer.invoke(IPC.removeRepo, id),

  // ── Tickets ──────────────────────────────────────────────────────────────
  listTickets: () => ipcRenderer.invoke(IPC.listTickets),

  // ── Sessions ─────────────────────────────────────────────────────────────
  startSession: (input) => ipcRenderer.invoke(IPC.startSession, input),

  writeSession: (id, data) => ipcRenderer.send(IPC.writeSession, id, data),
  resizeSession: (id, cols, rows) =>
    ipcRenderer.send(IPC.resizeSession, id, cols, rows),

  killSession: (id) => ipcRenderer.invoke(IPC.killSession, id),
  cleanupSession: (id, opts) =>
    ipcRenderer.invoke(IPC.cleanupSession, id, opts),

  // ── Push events (main → renderer) ────────────────────────────────────────
  onSessionData(cb: (id: string, data: string) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, id: string, data: string) =>
      cb(id, data)
    ipcRenderer.on(IPC.sessionData, listener)
    return () => ipcRenderer.removeListener(IPC.sessionData, listener)
  },

  onSessionStatus(cb: (id: string, status: SessionStatus) => void): () => void {
    const listener = (
      _e: Electron.IpcRendererEvent,
      id: string,
      status: SessionStatus,
    ) => cb(id, status)
    ipcRenderer.on(IPC.sessionStatus, listener)
    return () => ipcRenderer.removeListener(IPC.sessionStatus, listener)
  },
}

contextBridge.exposeInMainWorld('flotilla', api)
