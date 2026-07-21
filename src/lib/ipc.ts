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
  TicketSourceSettings,
  UsageTokens,
} from '../../electron/shared/contract.js'
import type { SlipstreamApi } from '../../electron/shared/contract.js'
import { DEFAULT_GC_POLICY, DEFAULT_SCHEDULER_POLICY } from '../../electron/shared/contract.js'

export const hasBackend = typeof window !== 'undefined' && !!window.slipstream

// Generic dispatch: call the real backend method when present, otherwise run
// `fallback` with the same arguments. Every named export below is one call to
// this — `K` pins argument/return types to the exact SlipstreamApi member
// being wrapped, so a mismatched fallback shape is a type error, not a
// runtime surprise the first time the no-backend path is exercised.
function call<K extends keyof SlipstreamApi>(
  name: K,
  fallback: (...args: Parameters<SlipstreamApi[K]>) => ReturnType<SlipstreamApi[K]>,
): SlipstreamApi[K] {
  // The indexed access `window.slipstream[name]` is typed as the union of every
  // SlipstreamApi member's signature, so TS can't confirm `args` (typed to the
  // one specific K this call site pins) matches whichever union member it
  // picks — a known TS limitation with generic indexed-access calls, not a
  // real type hole (name and args are both pinned to the same K by the caller).
  type Fn = (...args: Parameters<SlipstreamApi[K]>) => ReturnType<SlipstreamApi[K]>
  return ((...args: Parameters<SlipstreamApi[K]>) =>
    hasBackend ? (window.slipstream[name] as Fn)(...args) : fallback(...args)) as SlipstreamApi[K]
}

// Reused fallback shapes, so common no-backend behaviors aren't rewritten at
// every call site.
const NO_BACKEND = (): Promise<never> => Promise.reject(new Error('No backend'))
const NOOP = (): void => {}
const NOOP_UNSUBSCRIBE = (): (() => void) => NOOP

// ── Repos ──────────────────────────────────────────────────────────────────

export const listRepos = call('listRepos', () => Promise.resolve([]))

export const registerRepo = call('registerRepo', NO_BACKEND)

export const registerRepoByUrl = call('registerRepoByUrl', NO_BACKEND)

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

export const removeRepo = call('removeRepo', () => Promise.resolve())

// ── Tickets ────────────────────────────────────────────────────────────────

export const listTickets = call('listTickets', () =>
  Promise.resolve({ tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false }),
)

export const getTicketStatus = call('getTicketStatus', () =>
  Promise.resolve({ current: null, available: [] }),
)

export const setTicketStatus = call('setTicketStatus', NO_BACKEND)

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

export const getTicketSettings = call('getTicketSettings', () =>
  Promise.resolve({ ...EMPTY_TICKET_SETTINGS }),
)

export const setTicketSettings = call('setTicketSettings', NO_BACKEND)

export const listTicketScopes = call('listTicketScopes', () => Promise.resolve([]))

// ── Sessions ───────────────────────────────────────────────────────────────

export const startSession = call('startSession', NO_BACKEND)

export const writeSession = call('writeSession', NOOP)

export const resizeSession = call('resizeSession', NOOP)

/** Uploads a clipboard image to the daemon's per-session virtual clipboard. */
export const syncClipboardImage = call('syncClipboardImage', NO_BACKEND)

export const killSession = call('killSession', () => Promise.resolve())

export const cleanupSession = call('cleanupSession', () =>
  Promise.resolve({ removed: false, reason: 'no backend' }),
)

export const sessionMerged = call('sessionMerged', () => Promise.resolve({ merged: false }))

// ── Push event subscriptions ───────────────────────────────────────────────

/** Subscribe to PTY data chunks. Returns an unsubscribe fn. */
export const onSessionData = call('onSessionData', NOOP_UNSUBSCRIBE)

/** Fetch the buffered output snapshot for a session. */
export const getSessionBuffer = call('getSessionBuffer', () =>
  Promise.resolve({ data: '', seq: 0 }),
)

/** Subscribe to session status transitions. Returns an unsubscribe fn. */
export const onSessionStatus = call('onSessionStatus', NOOP_UNSUBSCRIBE)

/** Subscribe to a session's agent process exiting on its own (not on kill/reap).
 *  Returns an unsubscribe fn. */
export const onSessionExit = call('onSessionExit', NOOP_UNSUBSCRIBE)

export const listSessions = call('listSessions', () => Promise.resolve([]))

export const resumeSession = call('resumeSession', NO_BACKEND)

export const attachRemoteControl = call('attachRemoteControl', NO_BACKEND)

/** Continue an existing run with a different agent in the same worktree (FLO-102). */
export const handoffSession = call('handoffSession', NO_BACKEND)

export const worktreeStatus = call('worktreeStatus', (_repoId, branch) =>
  Promise.resolve({ branch, path: '', dirty: false, ahead: 0, behind: 0, added: 0, deleted: 0 }),
)

export const worktreeDiff = call('worktreeDiff', () =>
  Promise.resolve({ branch: '', base: '', mergeBase: '', files: [], truncated: false }),
)

export const worktreeUpdateFromBase = call('worktreeUpdateFromBase', NO_BACKEND)

// ── Editor ─────────────────────────────────────────────────────────────────

export const getEditorConfig = call('getEditorConfig', () =>
  Promise.resolve({ command: '', mobileCommand: '' }),
)

export const setEditorConfig = call('setEditorConfig', NO_BACKEND)

export const getAgentArgs = call('getAgentArgs', () => Promise.resolve({}))
export const setAgentArgs = call('setAgentArgs', NO_BACKEND)

export const openInEditor = call('openInEditor', NO_BACKEND)

export const getRepoSettings = call('getRepoSettings', () =>
  Promise.resolve({ installCmd: '', startCmd: '' }),
)
export const setRepoSettings = call('setRepoSettings', NO_BACKEND)

export const runApp = call('runApp', NO_BACKEND)

export const stopApp = call('stopApp', NO_BACKEND)

export const appStatus = call('appStatus', () => Promise.resolve({ running: false }))

// ── Push notifications ─────────────────────────────────────────────────────

export const getVapidPublicKey = call('getVapidPublicKey', () => Promise.resolve(''))

export const savePushSubscription = call('savePushSubscription', () => Promise.resolve())

export const deletePushSubscription = call('deletePushSubscription', () => Promise.resolve())

export const getPushPrefs = call('getPushPrefs', () => Promise.resolve(null))

export const saveFcmToken = call('saveFcmToken', () => Promise.resolve())

export const deleteFcmToken = call('deleteFcmToken', () => Promise.resolve())

// ── Git host tokens / PR push ───────────────────────────────────────────────

export const getGitToken = call('getGitToken', () => Promise.resolve(null))

export const setGitToken = call('setGitToken', NO_BACKEND)

export const listGitProviders = call('listGitProviders', () => Promise.resolve([]))

export const getGitHostConfig = call('getGitHostConfig', () =>
  Promise.resolve({ token: null, username: null, baseUrl: null }),
)

export const setGitHostConfig = call('setGitHostConfig', NO_BACKEND)

/** Subscribe to session PR/MR-opened events. Returns an unsubscribe fn. */
export const onSessionPr = call('onSessionPr', NOOP_UNSUBSCRIBE)

// ── Multi-client write lock ────────────────────────────────────────────────

export const attachSession = call('attachSession', (id) =>
  Promise.resolve({ sessionId: id, canWrite: true, viewers: 1 }),
)

export const detachSession = call('detachSession', NOOP)

export const takeWrite = call('takeWrite', (id) =>
  Promise.resolve({ sessionId: id, canWrite: true, viewers: 1 }),
)

export const onSessionWriteLock = call('onSessionWriteLock', NOOP_UNSUBSCRIBE)

// ── Session GC / cost guard policy ──────────────────────────────────────────

export const getGcPolicy = call('getGcPolicy', () => Promise.resolve({ ...DEFAULT_GC_POLICY }))

export const setGcPolicy = call('setGcPolicy', NO_BACKEND)

// ── Scheduler concurrency policy ────────────────────────────────────────────

export const getSchedulerPolicy = call('getSchedulerPolicy', () =>
  Promise.resolve({ ...DEFAULT_SCHEDULER_POLICY }),
)

export const setSchedulerPolicy = call('setSchedulerPolicy', NO_BACKEND)

// ── MCP status ───────────────────────────────────────────────────────────

export const getCliStatus = call('getCliStatus', NO_BACKEND)

// ── Diagnostics ──────────────────────────────────────────────────────────

export const getDiagnostics = call('getDiagnostics', NO_BACKEND)

// ── Prompt templates (FLO-98) ────────────────────────────────────────────

export const listPromptTemplates = call('listPromptTemplates', () => Promise.resolve([]))

export const savePromptTemplate = call('savePromptTemplate', NO_BACKEND)

export const deletePromptTemplate = call('deletePromptTemplate', NO_BACKEND)

// ── Agent CLI preflight ──────────────────────────────────────────────────

/** Checks whether `kind`'s CLI binary is on the daemon's PATH.
 *
 *  DESIGN-MODE FALLBACK: deliberately fabricates `found: true` — unlike every
 *  other hasBackend guard in this file (which return an honest empty/null/
 *  rejected value), there is no real check to honestly report the absence of
 *  here, and the UI must not nag about a missing CLI when there's no daemon
 *  to check against. This is intentional, not an oversight. */
export const checkAgentCli = call('checkAgentCli', (kind: BackendKind) =>
  Promise.resolve({ kind, bin: '', found: true }),
)

// ── Usage (token/cost) ─────────────────────────────────────────────────────

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }

/** Per-session token/cost usage parsed from the session's transcript JSONL. */
export const getSessionUsage = call('getSessionUsage', (sessionId) =>
  Promise.resolve({
    sessionId,
    exists: false,
    tokens: { ...ZERO_TOKENS },
    costUsd: 0,
    turns: 0,
  }),
)

/** Total + by-repo + by-day usage rollup for mission control. */
export const getUsageSummary = call('getUsageSummary', () =>
  Promise.resolve({
    total: { ...ZERO_TOKENS },
    costUsd: 0,
    byRepo: [],
    byDay: [],
    sessions: [],
  }),
)

// ── Session outcomes / history (FLO-97) ─────────────────────────────────────

/** Structured final summary reported by the agent, or null if none reported yet. */
export const getSessionOutcome = call('getSessionOutcome', () => Promise.resolve(null))

/** Owner-scoped history of all persisted sessions joined with outcomes + usage,
 *  most recent first; powers the History view. */
export const listSessionHistory = call('listSessionHistory', () => Promise.resolve([]))

// ── Agent CLI events (FLO-104) ───────────────────────────────────────────────

/** Persisted checkpoint/artifact/approval events for a session, oldest first. */
export const listSessionAgentEvents = call('listSessionAgentEvents', () => Promise.resolve([]))

/** Subscribe to live agent events. Returns an unsubscribe fn. */
export const onSessionAgentEvent = call('onSessionAgentEvent', NOOP_UNSUBSCRIBE)

// ── Chat transcript (TASK-FPH60) ────────────────────────────────────────────

/** Claude Code transcript tailed as chat. `available` is false when there's no
 *  backend, the session isn't claude-code, or it has no transcript file yet. */
export const getChatMessages = call('getChatMessages', () =>
  Promise.resolve({ available: false, messages: [] }),
)

/** Subscribe to live chat-message push. Returns an unsubscribe fn. */
export const onChatMessage = call('onChatMessage', NOOP_UNSUBSCRIBE)

/** Registers this client as a chat subscriber for `id` — opencode messages
 *  only arrive via server-side polling while at least one subscriber exists;
 *  claude/pi tails don't need it, so calling it for them is harmless. Call on
 *  ChatView mount, and unsubscribeChat on unmount. */
export const subscribeChat = call('subscribeChat', () => Promise.resolve())

/** Unregisters this client as a chat subscriber for `id`. See subscribeChat. */
export const unsubscribeChat = call('unsubscribeChat', () => Promise.resolve())

/** Discovered skills (SKILL.md-convention directories) available to a
 *  session's agent, for the chat input's `/`-command menu. */
export const listAgentSkills = call('listAgentSkills', () => Promise.resolve([]))

/** What is the agent asking, for the ChatView needs-input card. null when
 *  there's no backend, the session isn't in 'needs', or nothing is available
 *  to show (see ChatQuestionDTO). */
export const getChatQuestion = call('getChatQuestion', () => Promise.resolve(null))

// ── PR / CI status (FLO-96) ───────────────────────────────────────────────

/** Post-handoff PR/MR merge/CI/review state for a session. null when there's
 *  no backend or the session has no prUrl yet. */
export const getPrStatus = call('getPrStatus', () => Promise.resolve(null))

// ── Transport connectivity ──────────────────────────────────────────────────

/** Subscribe to backend transport connectivity (reconnects). Returns an unsubscribe fn. */
export const onConnectionChange = call('onConnectionChange', NOOP_UNSUBSCRIBE)
