/**
 * Renderer-side IPC client.
 *
 * `hasBackend` is true only inside Electron (window.slipstream is present).
 * When false (plain browser / Vite dev without Electron), all read calls
 * resolve to empty arrays and write calls are no-ops, so the renderer still
 * renders without crashing.
 */
import type {
  BackendKind,
  RepoDTO,
  RepoSettings,
  SessionDTO,
  TicketDTO,
  SessionStatus,
  WorkflowState,
  WorktreeInfo,
  EditorConfig,
  NotifyPrefs,
  PushSubscriptionDTO,
  GitHost,
  WriteLockState,
  GcPolicy,
} from '../../electron/shared/contract.js'
import { DEFAULT_GC_POLICY } from '../../electron/shared/contract.js'

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

export function registerRepoByUrl(remoteUrl: string): Promise<RepoDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.registerRepoByUrl(remoteUrl)
}

/** Opens a native folder picker and registers the chosen repo. Resolves null if cancelled or no backend. */
export function pickAndRegisterRepo(): Promise<RepoDTO | null> {
  const native = (window as Window & { __slipstreamNative?: { pickFolder(): Promise<string | null> } }).__slipstreamNative
  if (native?.pickFolder) {
    return native.pickFolder().then((p) => (p ? registerRepo(p) : null))
  }
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
  agentKind?: BackendKind
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

// ── Editor ─────────────────────────────────────────────────────────────────

export function getEditorConfig(): Promise<EditorConfig> {
  return hasBackend
    ? window.slipstream.getEditorConfig()
    : Promise.resolve({ command: '', mobileCommand: '' })
}

export function setEditorConfig(cfg: EditorConfig): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setEditorConfig(cfg)
}

export function openInEditor(input: { repoId: string; branch: string; mobile?: boolean }): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.openInEditor(input)
}

export function getRepoSettings(id: string): Promise<RepoSettings> {
  return hasBackend ? window.slipstream.getRepoSettings(id) : Promise.resolve({ installCmd: '', startCmd: '' })
}
export function setRepoSettings(id: string, settings: RepoSettings): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setRepoSettings(id, settings)
}
export function runApp(input: { repoId: string; branch: string }): Promise<{ started: boolean; reason?: string; port?: number }> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.runApp(input)
}

// ── Push notifications ─────────────────────────────────────────────────────

export function getVapidPublicKey(): Promise<string> {
  return hasBackend ? window.slipstream.getVapidPublicKey() : Promise.resolve('')
}

export function savePushSubscription(
  sub: PushSubscriptionDTO,
  prefs: NotifyPrefs
): Promise<void> {
  return hasBackend ? window.slipstream.savePushSubscription(sub, prefs) : Promise.resolve()
}

export function deletePushSubscription(endpoint: string): Promise<void> {
  return hasBackend ? window.slipstream.deletePushSubscription(endpoint) : Promise.resolve()
}

export function getPushPrefs(endpoint: string): Promise<NotifyPrefs | null> {
  return hasBackend ? window.slipstream.getPushPrefs(endpoint) : Promise.resolve(null)
}

// ── Git host tokens / PR push ───────────────────────────────────────────────

export function getGitToken(host: GitHost): Promise<string | null> {
  return hasBackend ? window.slipstream.getGitToken(host) : Promise.resolve(null)
}

export function setGitToken(host: GitHost, token: string): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setGitToken(host, token)
}

/** Subscribe to session PR/MR-opened events. Returns an unsubscribe fn. */
export function onSessionPr(
  cb: (id: string, prUrl: string) => void,
): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionPr(cb)
}

// ── Multi-client write lock ────────────────────────────────────────────────

export function attachSession(id: string): Promise<WriteLockState> {
  return hasBackend ? window.slipstream.attachSession(id) : Promise.resolve({ sessionId: id, canWrite: true, viewers: 1 })
}

export function detachSession(id: string): void {
  if (hasBackend) window.slipstream.detachSession(id)
}

export function takeWrite(id: string): Promise<WriteLockState> {
  if (!hasBackend) return Promise.resolve({ sessionId: id, canWrite: true, viewers: 1 })
  return window.slipstream.takeWrite(id)
}

export function onSessionWriteLock(cb: (state: WriteLockState) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionWriteLock(cb)
}

// ── Session GC / cost guard policy ──────────────────────────────────────────

export function getGcPolicy(): Promise<GcPolicy> {
  return hasBackend ? window.slipstream.getGcPolicy() : Promise.resolve({ ...DEFAULT_GC_POLICY })
}

export function setGcPolicy(policy: GcPolicy): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setGcPolicy(policy)
}
