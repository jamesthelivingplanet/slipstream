import { contextBridge, ipcRenderer } from 'electron'
import type { SlipstreamApi, SessionStatus } from './shared/contract.js'
import { IPC } from './shared/contract.js'

const api: SlipstreamApi = {
  // ── Repos ────────────────────────────────────────────────────────────────
  listRepos: () => ipcRenderer.invoke(IPC.listRepos),
  registerRepo: (absPath) => ipcRenderer.invoke(IPC.registerRepo, absPath),
  pickAndRegisterRepo: () => ipcRenderer.invoke(IPC.pickRepo),
  removeRepo: (id) => ipcRenderer.invoke(IPC.removeRepo, id),

  // ── Tickets ──────────────────────────────────────────────────────────────
  listTickets: () => ipcRenderer.invoke(IPC.listTickets),
  getTicketStatus: (tid) => ipcRenderer.invoke(IPC.getTicketStatus, tid),
  setTicketStatus: (tid, stateId) => ipcRenderer.invoke(IPC.setTicketStatus, tid, stateId),

  // ── Config / Integrations ────────────────────────────────────────────────
  getLinearKey: () => ipcRenderer.invoke(IPC.getLinearKey),
  setLinearKey: (key: string) => ipcRenderer.invoke(IPC.setLinearKey, key),
  getEditorConfig: () => ipcRenderer.invoke(IPC.getEditorConfig),
  setEditorConfig: (cfg) => ipcRenderer.invoke(IPC.setEditorConfig, cfg),
  openInEditor: (input) => ipcRenderer.invoke(IPC.openInEditor, input),

  // ── Sessions ─────────────────────────────────────────────────────────────
  startSession: (input) => ipcRenderer.invoke(IPC.startSession, input),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  resumeSession: (id: string) => ipcRenderer.invoke(IPC.resumeSession, id),
  attachRemoteControl: (id: string) => ipcRenderer.invoke(IPC.attachRemoteControl, id),

  writeSession: (id, data) => ipcRenderer.send(IPC.writeSession, id, data),
  resizeSession: (id, cols, rows) =>
    ipcRenderer.send(IPC.resizeSession, id, cols, rows),

  killSession: (id) => ipcRenderer.invoke(IPC.killSession, id),
  cleanupSession: (id, opts) =>
    ipcRenderer.invoke(IPC.cleanupSession, id, opts),

  // ── Push events (main → renderer) ────────────────────────────────────────
  onSessionData(cb: (id: string, data: string, seq: number) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, id: string, data: string, seq: number) =>
      cb(id, data, seq)
    ipcRenderer.on(IPC.sessionData, listener)
    return () => ipcRenderer.removeListener(IPC.sessionData, listener)
  },

  getSessionBuffer: (id) => ipcRenderer.invoke(IPC.getSessionBuffer, id),
  worktreeStatus: (repoId, branch) => ipcRenderer.invoke(IPC.worktreeStatus, repoId, branch),

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

contextBridge.exposeInMainWorld('slipstream', api)
