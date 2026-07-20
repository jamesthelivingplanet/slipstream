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
  BranchMergedDTO,
  PaginatedTickets,
  RepoDTO,
  RepoSettings,
  SessionDTO,
  SessionStatus,
  WorkflowState,
  WorktreeInfo,
  WorktreeDiffDTO,
  WorktreeUpdateMode,
  WorktreeUpdateResultDTO,
  EditorConfig,
  NotifyPrefs,
  PushSubscriptionDTO,
  FcmTokenDTO,
  GitHost,
  WriteLockState,
  GcPolicy,
  SchedulerPolicy,
  CliStatusDTO,
  DiagnosticsDTO,
  AgentCliCheck,
  TicketSource,
  ScopeOption,
  TicketSourceSettings,
  SessionUsage,
  UsageSummary,
  UsageTokens,
  PromptTemplateDTO,
  SessionOutcomeDTO,
  SessionHistoryEntry,
  SessionAgentEventDTO,
  PrStatusDTO,
  GitProviderInfoDTO,
  GitHostConfigDTO,
  SessionChatMessageDTO,
  AgentSkillDTO,
  ChatQuestionDTO,
} from '../../electron/shared/contract.js'
import { DEFAULT_GC_POLICY, DEFAULT_SCHEDULER_POLICY } from '../../electron/shared/contract.js'

export const hasBackend = typeof window !== 'undefined' && !!window.slipstream

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
  const native = (
    window as Window & { __slipstreamNative?: { pickFolder(): Promise<string | null> } }
  ).__slipstreamNative
  if (native?.pickFolder) {
    return native.pickFolder().then((p) => (p ? registerRepo(p) : null))
  }
  return hasBackend ? window.slipstream.pickAndRegisterRepo() : Promise.resolve(null)
}

export function removeRepo(id: string): Promise<void> {
  return hasBackend ? window.slipstream.removeRepo(id) : Promise.resolve()
}

// ── Tickets ────────────────────────────────────────────────────────────────

export function listTickets(opts?: {
  page?: number
  pageSize?: number
  query?: string
}): Promise<PaginatedTickets> {
  return hasBackend
    ? window.slipstream.listTickets(opts)
    : Promise.resolve({ tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false })
}

export function getTicketStatus(
  tid: string,
  src?: TicketSource,
): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
  return hasBackend
    ? window.slipstream.getTicketStatus(tid, src)
    : Promise.resolve({ current: null, available: [] })
}

export function setTicketStatus(
  tid: string,
  stateId: string,
  src?: TicketSource,
): Promise<WorkflowState> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setTicketStatus(tid, stateId, src)
}

// ── Ticket source settings (Linear / Jira credentials + scoping) ───────────

const EMPTY_TICKET_SETTINGS: TicketSourceSettings = {
  configured: false,
  scopeKeys: [],
  onlyMine: true,
  apiKey: '',
  baseUrl: '',
  email: '',
  apiToken: '',
}

export function getTicketSettings(src: TicketSource): Promise<TicketSourceSettings> {
  return hasBackend
    ? window.slipstream.getTicketSettings(src)
    : Promise.resolve({ ...EMPTY_TICKET_SETTINGS })
}

export function setTicketSettings(src: TicketSource, cfg: TicketSourceSettings): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setTicketSettings(src, cfg)
}

export function listTicketScopes(src: TicketSource): Promise<ScopeOption[]> {
  return hasBackend ? window.slipstream.listTicketScopes(src) : Promise.resolve([])
}

// ── Sessions ───────────────────────────────────────────────────────────────

export function startSession(input: {
  tid: string
  title: string
  prompt: string
  repoId: string
  description?: string
  agentKind?: BackendKind
  sessionId?: string
  src?: 'jira' | 'linear'
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

/** Uploads a clipboard image to the daemon's per-session virtual clipboard. */
export function syncClipboardImage(id: string, dataBase64: string): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.syncClipboardImage(id, dataBase64)
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

export function sessionMerged(id: string): Promise<BranchMergedDTO> {
  return hasBackend ? window.slipstream.sessionMerged(id) : Promise.resolve({ merged: false })
}

// ── Push event subscriptions ───────────────────────────────────────────────

/** Subscribe to PTY data chunks. Returns an unsubscribe fn. */
export function onSessionData(cb: (id: string, data: string, seq: number) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionData(cb)
}

/** Fetch the buffered output snapshot for a session. */
export function getSessionBuffer(id: string): Promise<{ data: string; seq: number }> {
  return hasBackend ? window.slipstream.getSessionBuffer(id) : Promise.resolve({ data: '', seq: 0 })
}

/** Subscribe to session status transitions. Returns an unsubscribe fn. */
export function onSessionStatus(cb: (id: string, status: SessionStatus) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionStatus(cb)
}

/** Subscribe to a session's agent process exiting on its own (not on kill/reap).
 *  Returns an unsubscribe fn. */
export function onSessionExit(cb: (id: string, code: number) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionExit(cb)
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

/** Continue an existing run with a different agent in the same worktree (FLO-102). */
export function handoffSession(id: string, agentKind: BackendKind): Promise<SessionDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.handoffSession(id, agentKind)
}

export function worktreeStatus(repoId: string, branch: string): Promise<WorktreeInfo> {
  return hasBackend
    ? window.slipstream.worktreeStatus(repoId, branch)
    : Promise.resolve({ branch, path: '', dirty: false, ahead: 0, behind: 0, added: 0, deleted: 0 })
}

export function worktreeDiff(repoId: string, branch: string): Promise<WorktreeDiffDTO> {
  return hasBackend
    ? window.slipstream.worktreeDiff(repoId, branch)
    : Promise.resolve({ branch: '', base: '', mergeBase: '', files: [], truncated: false })
}

export function worktreeUpdateFromBase(
  repoId: string,
  branch: string,
  mode: WorktreeUpdateMode,
): Promise<WorktreeUpdateResultDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.worktreeUpdateFromBase(repoId, branch, mode)
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

export function openInEditor(input: {
  repoId: string
  branch: string
  mobile?: boolean
}): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.openInEditor(input)
}

export function getRepoSettings(id: string): Promise<RepoSettings> {
  return hasBackend
    ? window.slipstream.getRepoSettings(id)
    : Promise.resolve({ installCmd: '', startCmd: '' })
}
export function setRepoSettings(id: string, settings: RepoSettings): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setRepoSettings(id, settings)
}
export function runApp(input: { repoId: string; branch: string }): Promise<{
  started: boolean
  reason?: string
  port?: number
  pid?: number
  reused?: boolean
  url?: string
}> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.runApp(input)
}

export function stopApp(input: { repoId: string; branch: string }): Promise<{ stopped: boolean }> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.stopApp(input)
}

export function appStatus(input: {
  repoId: string
  branch: string
}): Promise<{ running: boolean; url?: string }> {
  if (!hasBackend) return Promise.resolve({ running: false })
  return window.slipstream.appStatus(input)
}

// ── Push notifications ─────────────────────────────────────────────────────

export function getVapidPublicKey(): Promise<string> {
  return hasBackend ? window.slipstream.getVapidPublicKey() : Promise.resolve('')
}

export function savePushSubscription(sub: PushSubscriptionDTO, prefs: NotifyPrefs): Promise<void> {
  return hasBackend ? window.slipstream.savePushSubscription(sub, prefs) : Promise.resolve()
}

export function deletePushSubscription(endpoint: string): Promise<void> {
  return hasBackend ? window.slipstream.deletePushSubscription(endpoint) : Promise.resolve()
}

export function getPushPrefs(endpoint: string): Promise<NotifyPrefs | null> {
  return hasBackend ? window.slipstream.getPushPrefs(endpoint) : Promise.resolve(null)
}

export function saveFcmToken(token: FcmTokenDTO): Promise<void> {
  return hasBackend ? window.slipstream.saveFcmToken(token) : Promise.resolve()
}

export function deleteFcmToken(token: string): Promise<void> {
  return hasBackend ? window.slipstream.deleteFcmToken(token) : Promise.resolve()
}

// ── Git host tokens / PR push ───────────────────────────────────────────────

export function getGitToken(host: GitHost): Promise<string | null> {
  return hasBackend ? window.slipstream.getGitToken(host) : Promise.resolve(null)
}

export function setGitToken(host: GitHost, token: string): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setGitToken(host, token)
}

export function listGitProviders(): Promise<GitProviderInfoDTO[]> {
  return hasBackend ? window.slipstream.listGitProviders() : Promise.resolve([])
}

export function getGitHostConfig(host: GitHost): Promise<GitHostConfigDTO> {
  return hasBackend
    ? window.slipstream.getGitHostConfig(host)
    : Promise.resolve({ token: null, username: null, baseUrl: null })
}

export function setGitHostConfig(
  host: GitHost,
  cfg: { token?: string; username?: string; baseUrl?: string },
): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setGitHostConfig(host, cfg)
}

/** Subscribe to session PR/MR-opened events. Returns an unsubscribe fn. */
export function onSessionPr(cb: (id: string, prUrl: string) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionPr(cb)
}

// ── Multi-client write lock ────────────────────────────────────────────────

export function attachSession(id: string): Promise<WriteLockState> {
  return hasBackend
    ? window.slipstream.attachSession(id)
    : Promise.resolve({ sessionId: id, canWrite: true, viewers: 1 })
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

// ── Scheduler concurrency policy ────────────────────────────────────────────

export function getSchedulerPolicy(): Promise<SchedulerPolicy> {
  return hasBackend
    ? window.slipstream.getSchedulerPolicy()
    : Promise.resolve({ ...DEFAULT_SCHEDULER_POLICY })
}

export function setSchedulerPolicy(policy: SchedulerPolicy): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.setSchedulerPolicy(policy)
}

// ── MCP status ───────────────────────────────────────────────────────────

export function getCliStatus(): Promise<CliStatusDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.getCliStatus()
}

// ── Diagnostics ──────────────────────────────────────────────────────────

export function getDiagnostics(): Promise<DiagnosticsDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.getDiagnostics()
}

// ── Prompt templates (FLO-98) ────────────────────────────────────────────

export function listPromptTemplates(repoId: string): Promise<PromptTemplateDTO[]> {
  return hasBackend ? window.slipstream.listPromptTemplates(repoId) : Promise.resolve([])
}

export function savePromptTemplate(input: {
  id?: string
  repoId: string
  name: string
  body: string
}): Promise<PromptTemplateDTO> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.savePromptTemplate(input)
}

export function deletePromptTemplate(id: string): Promise<void> {
  if (!hasBackend) return Promise.reject(new Error('No backend'))
  return window.slipstream.deletePromptTemplate(id)
}

// ── Agent CLI preflight ──────────────────────────────────────────────────

/** Checks whether `kind`'s CLI binary is on the daemon's PATH. In design
 *  mode (no backend), resolves `found: true` so the UI doesn't nag when
 *  there's no real daemon to check against. */
export function checkAgentCli(kind: BackendKind): Promise<AgentCliCheck> {
  return hasBackend
    ? window.slipstream.checkAgentCli(kind)
    : Promise.resolve({ kind, bin: '', found: true })
}

// ── Usage (token/cost) ─────────────────────────────────────────────────────

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }

/** Per-session token/cost usage parsed from the session's transcript JSONL. */
export function getSessionUsage(sessionId: string): Promise<SessionUsage> {
  return hasBackend
    ? window.slipstream.getSessionUsage(sessionId)
    : Promise.resolve({
        sessionId,
        exists: false,
        tokens: { ...ZERO_TOKENS },
        costUsd: 0,
        turns: 0,
      })
}

/** Total + by-repo + by-day usage rollup for mission control. */
export function getUsageSummary(): Promise<UsageSummary> {
  return hasBackend
    ? window.slipstream.getUsageSummary()
    : Promise.resolve({
        total: { ...ZERO_TOKENS },
        costUsd: 0,
        byRepo: [],
        byDay: [],
        sessions: [],
      })
}

// ── Session outcomes / history (FLO-97) ─────────────────────────────────────

/** Structured final summary reported by the agent, or null if none reported yet. */
export function getSessionOutcome(sessionId: string): Promise<SessionOutcomeDTO | null> {
  return hasBackend ? window.slipstream.getSessionOutcome(sessionId) : Promise.resolve(null)
}

/** Owner-scoped history of all persisted sessions joined with outcomes + usage,
 *  most recent first; powers the History view. */
export function listSessionHistory(): Promise<SessionHistoryEntry[]> {
  return hasBackend ? window.slipstream.listSessionHistory() : Promise.resolve([])
}

// ── Agent CLI events (FLO-104) ───────────────────────────────────────────────

/** Persisted checkpoint/artifact/approval events for a session, oldest first. */
export function listSessionAgentEvents(sessionId: string): Promise<SessionAgentEventDTO[]> {
  return hasBackend ? window.slipstream.listSessionAgentEvents(sessionId) : Promise.resolve([])
}

/** Subscribe to live agent events. Returns an unsubscribe fn. */
export function onSessionAgentEvent(cb: (event: SessionAgentEventDTO) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onSessionAgentEvent(cb)
}

// ── Chat transcript (TASK-FPH60) ────────────────────────────────────────────

/** Claude Code transcript tailed as chat. `available` is false when there's no
 *  backend, the session isn't claude-code, or it has no transcript file yet. */
export function getChatMessages(
  id: string,
  opts?: { beforeTs?: number; limit?: number },
): Promise<{ available: boolean; messages: SessionChatMessageDTO[] }> {
  return hasBackend
    ? window.slipstream.getChatMessages(id, opts)
    : Promise.resolve({ available: false, messages: [] })
}

/** Subscribe to live chat-message push. Returns an unsubscribe fn. */
export function onChatMessage(cb: (id: string, msg: SessionChatMessageDTO) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onChatMessage(cb)
}

/** Registers this client as a chat subscriber for `id` — opencode messages
 *  only arrive via server-side polling while at least one subscriber exists;
 *  claude/pi tails don't need it, so calling it for them is harmless. Call on
 *  ChatView mount, and unsubscribeChat on unmount. */
export function subscribeChat(id: string): Promise<void> {
  return hasBackend ? window.slipstream.subscribeChat(id) : Promise.resolve()
}

/** Unregisters this client as a chat subscriber for `id`. See subscribeChat. */
export function unsubscribeChat(id: string): Promise<void> {
  return hasBackend ? window.slipstream.unsubscribeChat(id) : Promise.resolve()
}

/** Discovered skills (SKILL.md-convention directories) available to a
 *  session's agent, for the chat input's `/`-command menu. */
export function listAgentSkills(id: string): Promise<AgentSkillDTO[]> {
  return hasBackend ? window.slipstream.listAgentSkills(id) : Promise.resolve([])
}

/** What is the agent asking, for the ChatView needs-input card. null when
 *  there's no backend, the session isn't in 'needs', or nothing is available
 *  to show (see ChatQuestionDTO). */
export function getChatQuestion(id: string): Promise<ChatQuestionDTO | null> {
  return hasBackend ? window.slipstream.getChatQuestion(id) : Promise.resolve(null)
}

// ── PR / CI status (FLO-96) ───────────────────────────────────────────────

/** Post-handoff PR/MR merge/CI/review state for a session. null when there's
 *  no backend or the session has no prUrl yet. */
export function getPrStatus(sessionId: string): Promise<PrStatusDTO | null> {
  return hasBackend ? window.slipstream.getPrStatus(sessionId) : Promise.resolve(null)
}

// ── Transport connectivity ──────────────────────────────────────────────────

/** Subscribe to backend transport connectivity (reconnects). Returns an unsubscribe fn. */
export function onConnectionChange(cb: (connected: boolean) => void): () => void {
  if (!hasBackend) return () => {}
  return window.slipstream.onConnectionChange(cb)
}
