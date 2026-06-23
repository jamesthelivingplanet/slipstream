/**
 * Renderer-side IPC client.
 *
 * `hasBackend` is true only inside Electron (window.slipstream is present).
 * When false (plain browser / Vite dev without Electron), all read calls
 * resolve to empty arrays and write calls are no-ops, so the renderer still
 * renders without crashing.
 */
import type {
  RepoDTO,
  SessionDTO,
  TicketDTO,
  SessionStatus,
  WorkflowState,
  WorktreeInfo,
} from '../../electron/shared/contract.js'

export const hasBackend =
  typeof window !== 'undefined' && !!window.slipstream

// ── Repos ──────────────────────────────────────────────────────────────────

export function listRepos(): Promise<RepoDTO[]> {
  return hasBackend ? window.slipstream.listRepos() : Promise.resolve([])
}

export function registerRepo(absPath: string): Promise<RepoDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.registerRepo(absPath)
}

/** Opens a native folder picker and registers the chosen repo. Resolves null if cancelled or no backend. */
export function pickAndRegisterRepo(): Promise<RepoDTO | null> {
  return hasBackend ? window.slipstream.pickAndRegisterRepo() : Promise.resolve(null)
}

export function removeRepo(id: string): Promise<void> {
  return hasBackend ? window.slipstream.removeRepo(id) : Promise.resolve()
}

// ── Tickets ────────────────────────────────────────────────────────────────

export function listTickets(): Promise<TicketDTO[]> {
  return hasBackend ? window.slipstream.listTickets() : Promise.resolve([])
}

export function getTicketStatus(tid: string): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
  return hasBackend ? window.slipstream.getTicketStatus(tid) : Promise.resolve({ current: null, available: [] })
}

export function setTicketStatus(tid: string, stateId: string): Promise<WorkflowState> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setTicketStatus(tid, stateId)
}

// ── Sessions ───────────────────────────────────────────────────────────────

export function startSession(input: {
  tid: string
  title: string
  prompt: string
  repoId: string
  description?: string
}): Promise<SessionDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.startSession(input)
}

export function writeSession(id: string, data: string): void {
  if (hasBackend) window.slipstream.writeSession(id, data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  if (hasBackend) window.slipstream.resizeSession(id, cols, rows)
}

export function killSession(id: string): Promise<void> {
  return hasBackend ? window.slipstream.killSession(id) : Promise.resolve()
}

export function cleanupSession(
  id: string,
  opts?: { force?: boolean },
): Promise<{ removed: boolean; reason?: string }> {
  return hasBackend
    ? window.slipstream.cleanupSession(id, opts)
    : Promise.resolve({ removed: false, reason: 'no backend' })
}

// ── Push event subscriptions ───────────────────────────────────────────────

/** Subscribe to PTY data chunks. Returns an unsubscribe fn. */
export function onSessionData(
  cb: (id: string, data: string, seq: number) => void,
): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionData(cb)
}

/** Fetch the buffered output snapshot for a session. */
export function getSessionBuffer(
  id: string,
): Promise<{ data: string; seq: number }> {
  return hasBackend
    ? window.slipstream.getSessionBuffer(id)
    : Promise.resolve({ data: '', seq: 0 })
}

/** Subscribe to session status transitions. Returns an unsubscribe fn. */
export function onSessionStatus(
  cb: (id: string, status: SessionStatus) => void,
): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionStatus(cb)
}

export function listSessions(): Promise<SessionDTO[]> {
  return hasBackend ? window.slipstream.listSessions() : Promise.resolve([])
}

export function resumeSession(id: string): Promise<SessionDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.resumeSession(id)
}

export function attachRemoteControl(id: string): Promise<SessionDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.attachRemoteControl(id)
}

export function worktreeStatus(repoId: string, branch: string): Promise<WorktreeInfo> {
  return hasBackend
    ? window.slipstream.worktreeStatus(repoId, branch)
    : Promise.resolve({ branch, path: '', dirty: false, ahead: 0, behind: 0, added: 0, deleted: 0 })
}
