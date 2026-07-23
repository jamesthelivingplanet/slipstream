import { writable, derived, get } from 'svelte/store'
import { statusBucket } from './types'
import type { Filter, Repo, Session, Status, Ticket, BackendKind, Source } from './types'
import type {
  RepoDTO,
  SessionDTO,
  TicketDTO,
  WorktreeUpdateMode,
} from '../../electron/shared/contract.js'
import { branchFor } from './branch'
import {
  hasBackend,
  listRepos,
  listTickets,
  listSessions,
  pickAndRegisterRepo,
  registerRepo as ipcRegisterRepo,
  registerRepoByUrl as ipcRegisterRepoByUrl,
  removeRepo,
  startSession,
  killSession,
  cleanupSession,
  sessionMerged,
  getTicketStatus,
  worktreeStatus,
  worktreeUpdateFromBase,
  runApp,
  onSessionStatus,
  onSessionPr,
  onConnectionChange,
} from './ipc'
import { pushToast } from './toast'
import { nativeStorage, DRAFTS_KEY } from './nativeStorage'
import { sessionsToReconcile } from './reconcile'
import { isStartableTicket } from './ticketFilter.js'
import { cleanError } from './stores/errors.js'
import { confirmDialog } from './stores/confirmDialog.js'
import { appRunKey, setAppRunning, stopAppForSession } from './stores/appRunner.js'
import { buzzNeedsYou } from './haptics'
export { sessionsToReconcile } from './reconcile'
export { isStartableTicket } from './ticketFilter.js'
export * from './stores/confirmDialog.js'
export { cleanError } from './stores/errors.js'
export * from './stores/cliStatus.js'
export * from './stores/reviewComments.js'
export {
  runningApps,
  appRunKey,
  appUrls,
  stopAppForSession,
  refreshAppStatus,
} from './stores/appRunner.js'

function dtoToTickets(
  dtos: {
    tid: string
    src: string
    title: string
    repoHint?: string
    description?: string
    status?: { id: string; name: string; type?: string }
    done: boolean
  }[],
): Ticket[] {
  return dtos.map((d) => ({
    tid: d.tid,
    src: d.src as 'jira' | 'linear',
    title: d.title,
    repo: d.repoHint ?? '',
    description: d.description,
    status: d.status,
    done: d.done,
  }))
}

/** Map a persisted SessionDTO to the renderer Session model. Exported so the
 *  src round-trip is unit-testable. Legacy rows with no persisted source
 *  default to 'jira'. */
export function dtoToSession(dto: SessionDTO): Session {
  // Used to pessimistically relabel a persisted 'running'/'needs' status as
  // 'detached', guessing that a daemon restart had orphaned the process and a
  // corrective live `status` push would arrive shortly to fix it back up. That
  // guess is now stale: restoreInterruptedSessions (electron/services/sessionStore.ts)
  // runs at daemon boot, before any RPC is served, and converts any genuinely
  // orphaned running/needs session to 'interrupted' first. So a 'running'/'needs'
  // status reported here is already known-live — trust it directly, exactly like
  // every subsequent live update already does via setSessionStatus. Guessing
  // 'detached' instead could stick indefinitely for poll-driven backends
  // (pi/opencode/kilo) that don't self-correct via the PTY-driven status flap.
  const uiStatus = dto.status as Status
  return {
    id: dto.id,
    tid: dto.tid,
    src: (dto.src ?? 'jira') as Source,
    status: uiStatus,
    title: dto.title,
    repo: dto.repoId,
    branch: dto.branch,
    add: 0,
    del: 0,
    behind: 0,
    ago: '',
    prompt: dto.prompt,
    port: dto.port,
    agentKind: dto.agentKind,
    prUrl: dto.prUrl,
    activity: {
      text:
        uiStatus === 'interrupted'
          ? 'Interrupted by restart — open to resume.'
          : uiStatus === 'reaped'
            ? 'Reaped by the cost guard.'
            : uiStatus === 'queued'
              ? 'Queued — will start when an agent slot frees.'
              : 'Detached — open to resume.',
    },
  }
}

export function openRepoSettings(repoId: string) {
  settingsRepoId.set(repoId)
  settingsOpen.set(true)
}

/**
 * FLO-114: local drafts (status 'idle', created by createAgentFromTicket /
 * createBlankAgent) exist only in the renderer store — the backend never
 * persists a session row until startSession is called, and startSession
 * always returns status 'running'/'queued'. So a draft can never appear in
 * `dtos`, and re-seeding sessions from the backend must preserve any current
 * drafts rather than `sessions.set()`-ing over them, or a WS reconnect (or a
 * retried initial load) silently deletes whatever the user is typing.
 */
function mergeSessionsPreservingDrafts(dtos: SessionDTO[]): Session[] {
  const freshIds = new Set(dtos.map((d) => d.id))
  const drafts = get(sessions).filter(
    (s) => s.status === 'idle' && (s.id === undefined || !freshIds.has(s.id)),
  )
  return [...drafts, ...dtos.map(dtoToSession)]
}

const DRAFT_PERSIST_DEBOUNCE_MS = 500
let draftPersistTimer: ReturnType<typeof setTimeout> | undefined

/**
 * FLO-114: a page reload drops the renderer store entirely, so — unlike the
 * WS-reconnect case above — there is no in-memory draft left to preserve.
 * Best-effort snapshot every current 'idle' draft to nativeStorage so
 * loadPersistedDrafts() can restore it on the next boot. Fire-and-forget:
 * losing a draft-persistence write must never surface as an error to the
 * user typing a kickoff prompt.
 */
function persistDraftsNow(): void {
  const drafts = get(sessions).filter((s) => s.status === 'idle')
  const write = drafts.length
    ? nativeStorage.set(DRAFTS_KEY, JSON.stringify(drafts))
    : nativeStorage.remove(DRAFTS_KEY)
  write.catch(() => {})
}

/** Debounced persistDraftsNow(), for high-frequency callers (prompt typing). */
function schedulePersistDrafts(): void {
  clearTimeout(draftPersistTimer)
  draftPersistTimer = setTimeout(persistDraftsNow, DRAFT_PERSIST_DEBOUNCE_MS)
}

/** Restore drafts saved by a previous session that were never started or
 *  discarded. Best-effort: any missing/malformed value yields no drafts,
 *  never a thrown error. */
async function loadPersistedDrafts(): Promise<Session[]> {
  try {
    const raw = await nativeStorage.get(DRAFTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is Session => !!s && typeof s === 'object' && (s as Session).status === 'idle',
    )
  } catch {
    return []
  }
}

/** Live-sync an in-progress draft's kickoff prompt into the store as the
 *  user types (FLO-114), so the debounced persistDraftsNow() snapshot holds
 *  the actual in-progress text rather than the placeholder set at draft
 *  creation. No-op once the session has left 'idle' (started/discarded). */
export function updateDraftPrompt(id: string, prompt: string): void {
  let changed = false
  sessions.update(($s) =>
    $s.map((s) => {
      if (s.id !== id || s.status !== 'idle') return s
      changed = true
      return { ...s, prompt }
    }),
  )
  if (changed) schedulePersistDrafts()
}

export const repos = writable<Repo[]>([])
export const sessions = writable<Session[]>([])
export const tickets = writable<Ticket[]>([])
export const selectedId = writable<string | null>(null)
export const filter = writable<Filter>('all')
export const query = writable<string>('')
export const dialogOpen = writable<boolean>(false)
export const settingsOpen = writable<boolean>(false)
export const settingsRepoId = writable<string | null>(null)
// FLO-97: the Run history view, toggled from the header.
export const historyOpen = writable<boolean>(false)

export const ticketsTotalCount = writable<number>(0)
export const ticketsPage = writable<number>(1)
export const ticketsPageSize = writable<number>(20)
export const ticketsHasMore = writable<boolean>(false)
export const ticketsLoading = writable<boolean>(false)
export const ticketsQuery = writable<string>('')

/** The session id currently booting up (creating its worktree + spawning its
 *  agent), or null. Set by `startAgent` for a foreground (selected) start and
 *  cleared once the backend `startSession` resolves — drives the Nulliel
 *  loading screen over that agent's terminal (TASK-RAHTX). Batch starts
 *  (startAgentsFromTickets) never select, so they never set this. */
export const bootingId = writable<string | null>(null)

/** True when the viewport is at or below the mobile breakpoint. Synced from App.svelte. */
export const mobile = writable<boolean>(false)

/** Height (px) of the on-screen keyboard overlapping the viewport (mobile). Synced from App.svelte. */
export const keyboardInset = writable<number>(0)

/** True when the viewport is at or below the drawer breakpoint (≤900px), meaning
 *  the agent list sidebar should be a toggleable overlay drawer. Synced from App.svelte. */
export const drawer = writable<boolean>(false)

/** True when the WS transport is up (FLO-108). Defaults true so design mode
 *  (no backend) never shows a disconnected banner — subscribeConnectionChange
 *  is the only writer, and it's a no-op without hasBackend. */
export const connected = writable<boolean>(true)

// FLO-56: the header refresh button doubles as the agent-content fetch indicator.
// TicketStatusBar reports its ticket-status fetch here so the header can show loading/resolved.
export const contentLoading = writable<boolean>(false)
// Bumped (to Date.now()) each time a content fetch resolves successfully; header shows a brief check mark.
export const contentResolvedAt = writable<number>(0)
// Bumped by the header refresh button to force a re-fetch of the selected agent's content.
export const contentRefreshNonce = writable<number>(0)

export const selected = derived([sessions, selectedId], ([$sessions, $id]) =>
  $id ? ($sessions.find((s) => s.id === $id) ?? null) : null,
)

export const counts = derived(sessions, ($sessions) => {
  const c = { all: $sessions.length, needs: 0, running: 0, done: 0 } as Record<string, number>
  for (const s of $sessions) {
    const bucket = statusBucket(s.status)
    if (bucket) c[bucket] += 1
  }
  return c
})

export const visible = derived([sessions, filter, query], ([$sessions, $filter, $query]) => {
  const q = $query.toLowerCase()
  return $sessions.filter(
    (s) =>
      ($filter === 'all' || statusBucket(s.status) === $filter) &&
      (s.title.toLowerCase().includes(q) || s.tid.toLowerCase().includes(q)),
  )
})

/** Look up a repo by id from the current store value. */
export function repoById(id: string | null | undefined): Repo | undefined {
  if (!id) return undefined
  return get(repos).find((r) => r.id === id)
}

function patch(id: string, fn: (s: Session) => Session) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? fn(s) : s)))
}

export function select(tid: string | null) {
  selectedId.set(tid)
  if (tid) historyOpen.set(false)
}

/** Deep-link entry point (TASK-F0TYG): opens the agent a notification points
 *  at. Shared by every notification transport that can deliver a tap/click —
 *  the service-worker 'open-agent' message (App.svelte), the `?agent=` query
 *  param set by the SW's notificationclick before it opens/focuses a window
 *  (App.svelte), and the native FCM pushNotificationActionPerformed listener
 *  (push.ts) — so they all land on the exact same behavior instead of each
 *  reimplementing "select this session". */
export function openAgentById(sessionId: string) {
  select(sessionId)
}

/** Seed stores from the real backend. No-op when hasBackend is false. */
export async function initFromBackend(): Promise<void> {
  if (!hasBackend) {
    initialLoadLoading.set(false)
    return
  }

  initialLoadLoading.set(true)
  initialLoadError.set(null)

  let repoDTOs: RepoDTO[] = []
  let ticketDTOs: TicketDTO[] = []
  let sessionDTOs: SessionDTO[] = []

  try {
    repoDTOs = await listRepos()
  } catch (e) {
    pushToast('error', `Failed to load repositories: ${cleanError(e)}`)
    initialLoadError.set('repos')
  }

  try {
    const ticketResult = await listTickets({ page: 1, pageSize: 20 })
    ticketDTOs = ticketResult.tickets
    ticketsTotalCount.set(ticketResult.totalCount)
    ticketsHasMore.set(ticketResult.hasMore)
  } catch (e) {
    pushToast('error', `Failed to load tickets: ${cleanError(e)}`)
    initialLoadError.set('tickets')
  }

  try {
    sessionDTOs = await listSessions()
  } catch (e) {
    pushToast('error', `Failed to load sessions: ${cleanError(e)}`)
    initialLoadError.set('sessions')
  }

  repos.set(
    repoDTOs.map((d) => ({
      id: d.id,
      org: d.org,
      name: d.name,
      base: d.base,
    })),
  )

  tickets.set(dtoToTickets(ticketDTOs).filter(isStartableTicket))

  sessions.set(mergeSessionsPreservingDrafts(sessionDTOs))

  // FLO-114: a page reload has no in-memory draft for
  // mergeSessionsPreservingDrafts to have found above — restore whatever was
  // last persisted to nativeStorage instead. Skip anything whose id already
  // landed in the store (a live draft created while this load was in
  // flight, or — vanishingly unlikely — a real backend session).
  const persistedDrafts = await loadPersistedDrafts()
  if (persistedDrafts.length) {
    const existingIds = new Set(
      get(sessions)
        .map((s) => s.id)
        .filter((id): id is string => id !== undefined),
    )
    const restored = persistedDrafts.filter((d) => d.id === undefined || !existingIds.has(d.id))
    if (restored.length) sessions.update(($s) => [...restored, ...$s])
  }

  await refreshDiffStats().catch(() => {})

  initialLoadLoading.set(false)
}

export const initialLoadLoading = writable<boolean>(true)
export const initialLoadError = writable<'repos' | 'tickets' | 'sessions' | null>(null)

export function retryInitialLoad(): void {
  initFromBackend()
}

/** Fetch real worktree diff stats for every started agent and update its +add/-del badge. */
export async function refreshDiffStats(): Promise<void> {
  if (!hasBackend) return
  const started = get(sessions).filter((s) => s.id && s.repo && s.branch)
  await Promise.all(
    started.map(async (s) => {
      try {
        const info = await worktreeStatus(s.repo as string, s.branch as string)
        patch(s.id as string, (x) => ({
          ...x,
          add: info.added,
          del: info.deleted,
          behind: info.behind,
        }))
      } catch {
        // leave existing values on failure
      }
    }),
  )
}

export async function refreshTickets(): Promise<void> {
  if (!hasBackend) return
  ticketsLoading.set(true)
  try {
    const page = get(ticketsPage)
    const pageSize = get(ticketsPageSize)
    const query = get(ticketsQuery)
    const result = await listTickets({ page, pageSize, query: query || undefined })
    tickets.set(dtoToTickets(result.tickets).filter(isStartableTicket))
    ticketsTotalCount.set(result.totalCount)
    ticketsHasMore.set(result.hasMore)
  } catch (e) {
    pushToast('error', cleanError(e))
  } finally {
    ticketsLoading.set(false)
  }
}

export async function loadMoreTickets(): Promise<void> {
  if (!hasBackend || get(ticketsLoading) || !get(ticketsHasMore)) return
  ticketsLoading.set(true)
  try {
    const nextPage = get(ticketsPage) + 1
    const pageSize = get(ticketsPageSize)
    const query = get(ticketsQuery)
    const result = await listTickets({ page: nextPage, pageSize, query: query || undefined })
    tickets.update(($t) => [...$t, ...dtoToTickets(result.tickets).filter(isStartableTicket)])
    ticketsTotalCount.set(result.totalCount)
    ticketsPage.set(nextPage)
    ticketsHasMore.set(result.hasMore)
  } catch (e) {
    pushToast('error', cleanError(e))
  } finally {
    ticketsLoading.set(false)
  }
}

export function setTicketsQuery(query: string): void {
  ticketsQuery.set(query)
  ticketsPage.set(1)
  refreshTickets()
}

/** Insert or replace a repo summary in the store, keyed by id (registration is
 *  idempotent backend-side, so re-registering must not duplicate the row). */
function upsertRepoEntry(dto: { id: string; org: string; name: string; base: string }): void {
  const entry = { id: dto.id, org: dto.org, name: dto.name, base: dto.base }
  repos.update(($r) => {
    const i = $r.findIndex((r) => r.id === entry.id)
    if (i === -1) return [...$r, entry]
    const next = [...$r]
    next[i] = entry
    return next
  })
}

/** Open the native folder picker and register the chosen repo. */
export async function registerRepo(): Promise<void> {
  try {
    const dto = await pickAndRegisterRepo()
    if (!dto) return
    upsertRepoEntry(dto)
    pushToast('success', `Imported ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Web fallback: register a repo by typing an absolute path directly. */
export async function registerRepoByPath(absPath: string): Promise<void> {
  try {
    const dto = await ipcRegisterRepo(absPath)
    upsertRepoEntry(dto)
    pushToast('success', `Imported ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Clone & register a repo from its git remote URL. Works in web and desktop. */
export async function registerRepoByUrl(remoteUrl: string): Promise<void> {
  try {
    const dto = await ipcRegisterRepoByUrl(remoteUrl)
    upsertRepoEntry(dto)
    pushToast('success', `Cloned ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

export async function removeRepoById(id: string): Promise<void> {
  const repo = repoById(id)
  const label = repo ? `${repo.org}/${repo.name}` : 'this repository'
  const liveSessions = get(sessions).filter((s) => s.repo === id)
  if (liveSessions.length > 0) {
    const n = liveSessions.length
    pushToast(
      'error',
      `Can't remove ${label}: ${n} session${n === 1 ? '' : 's'} still ${n === 1 ? 'references' : 'reference'} it. Clean those up first.`,
    )
    return
  }
  const ok = await confirmDialog({
    title: 'Remove repository?',
    message: `This untracks ${label} from Slipstream. It doesn't delete anything on disk.`,
    confirmLabel: 'Remove',
    danger: true,
  })
  if (!ok) return
  try {
    await removeRepo(id)
    repos.update(($r) => $r.filter((r) => r.id !== id))
    pushToast('success', 'Removed repository')
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

export function createAgentFromTicket(
  ticket: Ticket,
  prompt: string,
  agentKind: BackendKind = 'claude-code',
  opts?: { select?: boolean },
): string {
  const doSelect = opts?.select ?? true
  const id = crypto.randomUUID()
  tickets.update(($t) => $t.filter((t) => t.tid !== ticket.tid))
  sessions.update(($s) => [
    {
      id,
      tid: ticket.tid,
      src: ticket.src,
      status: 'idle' as Status,
      title: ticket.title,
      repo: null,
      suggestedRepo: ticket.repo,
      branch: null,
      add: 0,
      del: 0,
      behind: 0,
      ago: 'draft',
      prompt,
      description: ticket.description,
      activity: { text: 'Not started.' },
      agentKind,
    },
    ...$s,
  ])
  persistDraftsNow()
  if (doSelect) {
    dialogOpen.set(false)
    select(id)
  }
  return id
}

export function createBlankAgent(
  title: string,
  prompt: string,
  tid: string = `TASK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
  agentKind: BackendKind = 'claude-code',
): string {
  const id = crypto.randomUUID()
  sessions.update(($s) => [
    {
      id,
      tid,
      src: 'jira',
      status: 'idle',
      title,
      repo: null,
      branch: null,
      add: 0,
      del: 0,
      behind: 0,
      ago: 'draft',
      prompt,
      activity: { text: 'Not started.' },
      agentKind,
    },
    ...$s,
  ])
  persistDraftsNow()
  dialogOpen.set(false)
  select(id)
  return id
}

/**
 * Escape hatch for a draft session created via createAgentFromTicket/createBlankAgent:
 * only acts on an untouched 'idle' draft, drops it from the sidebar, deselects it if
 * selected, and — when the draft was seeded from a real ticket — refreshes the ticket
 * list so the backend's copy (which was never actually removed, just locally filtered
 * out) reappears in the launchpad.
 */
export function discardDraft(s: Session): void {
  if (s.status !== 'idle') return
  const cameFromTicket = s.suggestedRepo !== undefined
  sessions.update(($s) => $s.filter((x) => x.id !== s.id))
  persistDraftsNow()
  if (get(selectedId) === s.id) select(null)
  if (cameFromTicket && hasBackend) {
    refreshTickets()
  }
  pushToast('success', `Discarded draft ${s.tid}`)
}

export async function startAgent(
  id: string,
  repoId: string,
  prompt: string,
  agentKind?: BackendKind,
  extraArgs?: string,
) {
  const s = get(sessions).find((x) => x.id === id)
  if (!s) return

  if (hasBackend) {
    // Only the agent the user is actively watching start gets the Nulliel
    // booting screen — batch-launched agents (startAgentsFromTickets) are
    // never selected, so bootingId stays null for them and they don't flash a
    // global loader. (TASK-RAHTX)
    const foreground = get(selectedId) === id
    if (foreground) bootingId.set(id)
    // Optimistically update to show activity before the async call resolves.
    patch(id, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      status: 'running',
      ago: 'just now',
      activity: { text: 'Creating worktree & starting claude…' },
    }))
    // No longer a draft — drop it from persisted storage now, not just once
    // the async startSession below resolves (FLO-114).
    persistDraftsNow()
    try {
      const dto = await startSession({
        tid: s.tid,
        title: s.title,
        prompt,
        repoId,
        description: s.description,
        agentKind,
        sessionId: id,
        src: s.src,
        extraArgs,
      })
      patch(id, (s) => ({
        ...s,
        id: dto.id,
        branch: dto.branch,
        port: dto.port,
        agentKind: dto.agentKind,
        repo: repoId,
        status: dto.status,
        activity:
          dto.status === 'queued'
            ? { text: 'Queued — will start when an agent slot frees.' }
            : s.activity,
      }))
      if (dto.status === 'queued') {
        pushToast('success', `Queued ${s.tid} — starts when a slot frees`)
      }
    } catch (err) {
      patch(id, (s) => ({
        ...s,
        status: 'errored',
        activity: { text: cleanError(err) },
      }))
      pushToast('error', cleanError(err))
    } finally {
      if (foreground) bootingId.set(null)
    }
  } else {
    // Mock path — simulate immediately.
    patch(id, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      branch: branchFor(s.tid, s.title),
      agentKind,
      status: 'running',
      ago: 'just now',
      activity: { text: 'Creating worktree & starting claude…' },
    }))
    persistDraftsNow()
  }
}

/** FLO-95 batch flow: launch agents for every ticket whose repo hint matches a
 *  registered repo, without stealing selection/closing dialogs per ticket. The
 *  backend scheduler queues starts beyond the concurrency cap and drains them. */
export async function startAgentsFromTickets(
  ts: Ticket[],
  agentKind: BackendKind = 'claude-code',
): Promise<number> {
  let started = 0
  for (const t of ts) {
    const repo = repoById(t.repo)
    if (!repo) continue
    const prompt = `Begin implementing ${t.tid}.`
    const id = createAgentFromTicket(t, prompt, agentKind, { select: false })
    await startAgent(id, repo.id, prompt, agentKind)
    started++
  }
  return started
}

/**
 * Subscribe to the backend's global session-status broadcast and mirror every
 * transition into the store for ALL sessions (not just the selected one).
 * This keeps the Agent list + filters live without each TerminalView needing
 * its own per-terminal subscription. `setSessionStatus` dedupes desktop
 * notifications per episode (re-armed by `markSessionInput` on the writeSession
 * path — the renderer mirror of the backend `input` session event), so this is
 * safe even though TerminalView no longer subscribes.
 */
export function subscribeSessionStatus(): () => void {
  if (!hasBackend) return () => {}
  return onSessionStatus((id, status) => setSessionStatus(id, status as Status))
}

/** Subscribe to the backend's session PR/MR-opened broadcast and mirror it into the store. */
export function subscribeSessionPr(): () => void {
  if (!hasBackend) return () => {}
  return onSessionPr((id, prUrl) => setSessionPrUrl(id, prUrl))
}

/**
 * Subscribe to transport reconnects and re-seed `sessions` from the backend
 * (FLO-103). Any status/exit/PR pushes missed while disconnected are lost —
 * a full refresh is the simplest way to reconcile the backend-known sessions,
 * and matches what a manual remount already did before reconnect handling
 * existed. Local 'idle' drafts are never backend-known, so they're merged
 * back in rather than wiped out from under a typing user (FLO-114).
 */
export function subscribeConnectionChange(): () => void {
  if (!hasBackend) return () => {}
  let wasDisconnected = false
  return onConnectionChange((isConnected) => {
    connected.set(isConnected)
    if (!isConnected) {
      wasDisconnected = true
      return
    }
    if (!wasDisconnected) return
    wasDisconnected = false
    listSessions()
      .then((dtos) => sessions.set(mergeSessionsPreservingDrafts(dtos)))
      .then(() => refreshDiffStats().catch(() => {}))
      .catch(() => {})
  })
}

/** Update the PR/MR URL of the session identified by its backend UUID. */
export function setSessionPrUrl(id: string, prUrl: string) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, prUrl } : s)))
}

/** Record that a session's run was handed off to a different agent (FLO-102). */
export function setSessionAgent(id: string, agentKind: BackendKind) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, agentKind } : s)))
}

// FLO-105: per-session set of desktop-notification kinds already fired this
// episode. The status detector's heuristics flap on idle TUIs (screen repaint →
// running, quiet prompt → needs, repeat), so a per-transition check re-notifies
// forever. Each kind fires at most once per episode; an episode ends on real
// user input (markSessionInput, wired to the writeSession IPC path) or session
// exit/reap. Mirrors pushService.ts's `notified` map — the documented
// reference (ARCHITECTURE.md §Session status pipeline).
const notified = new Map<string, Set<'needs' | 'done'>>()

/** Update the status of the session identified by its backend UUID. */
export function setSessionStatus(id: string, status: Status) {
  let prev: Status | undefined
  let title: string | undefined
  sessions.update(($s) =>
    $s.map((s) => {
      if (s.id !== id) return s
      prev = s.status
      title = s.title
      // A tearing-down session is being removed by cleanupAgent; ignore any
      // backend status push (e.g. the PTY-exit flap when it's killed) so the
      // "Tearing down" loading state doesn't flicker to running/done before
      // the row is dropped. (TASK-RAHTX)
      if (s.status === 'tearing-down') return s
      // FLO-105: needsSince is episode-scoped, not transition-scoped. Stamp it
      // on the FIRST entry into 'needs' this episode and PRESERVE it across the
      // needs→running→needs heuristic flap, so Mission Control's "waiting Xm"
      // shows when the agent actually went idle rather than snapping back to 0
      // on every re-entry. It's cleared on real user input (markSessionInput)
      // and on session reap/removal — never on a transition out of 'needs',
      // which is what caused the label to flicker.
      if (status === 'needs' && prev !== 'needs' && s.needsSince === undefined) {
        return { ...s, status, needsSince: Date.now() }
      }
      return { ...s, status }
    }),
  )
  // Reaped sessions are terminal: drop their episode tracking so the map can't
  // grow unboundedly across the renderer's lifetime.
  if (status === 'reaped') {
    notified.delete(id)
    return
  }
  if (prev !== status && (status === 'needs' || status === 'done')) {
    // Per-episode dedupe (FLO-105): without this, the needs↔running flap on an
    // idle TUI fires a fresh "Agent needs you" Notification every few seconds.
    const seen = notified.get(id)
    if (seen?.has(status)) return
    const next = new Set(seen)
    next.add(status)
    notified.set(id, next)
    // FLO-161: haptic buzz on the same per-episode dedupe as the desktop
    // notification below, but independent of it — notifyTransition() early-
    // returns when the bare `Notification` API is unavailable/ungranted,
    // which must never suppress the native haptic on mobile.
    if (status === 'needs') buzzNeedsYou()
    notifyTransition(status, title)
  }
}

/**
 * FLO-105: re-arm per-episode desktop-notification + needsSince tracking for a
 * session. Called on the writeSession path (real user input) — the renderer
 * equivalent of the backend `input` session event that re-arms pushService.ts's
 * `notified` map. Without this, the next genuine needs/done transition after the
 * user responds would be silently swallowed by the per-episode dedupe, and the
 * "waiting Xm" clock would keep counting from the stale pre-response entry.
 */
export function markSessionInput(id: string) {
  notified.delete(id)
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, needsSince: undefined } : s)))
}

/**
 * Best-effort desktop notification; silently no-ops if unavailable/not yet granted.
 * Permission is requested only from a user gesture in the settings UI
 * (src/lib/push.ts `enablePush`, invoked from SettingsNotifications.svelte's Enable
 * button) — browsers require a gesture for Notification.requestPermission(), so this
 * status-transition handler must never call it itself.
 */
function notifyTransition(status: 'needs' | 'done', title?: string) {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const heading = status === 'needs' ? 'Agent needs you' : 'Agent finished'
    new Notification(heading, { body: title ?? '' })
  } catch {
    /* notifications unsupported — ignore */
  }
}

/** Remove a session by its backend UUID from the store. */
export function removeSession(id: string) {
  // FLO-105: drop per-episode notification tracking so the map can't grow
  // unboundedly as sessions come and go.
  notified.delete(id)
  sessions.update(($s) => $s.filter((s) => s.id !== id))
}

export function resolveNeedsInput(id: string) {
  patch(id, (s) => ({
    ...s,
    status: 'running',
    activity: { text: 'Applying decision, writing the fix…' },
  }))
}

/**
 * Shared agent teardown: kill the PTY, remove worktree+branch via the backend,
 * and drop it from the sidebar. `auto` (refresh-driven) SKIPS a dirty/unmerged
 * worktree and surfaces a warning instead of removing it — force-destroying
 * unpushed agent work behind the user's back is a data-loss bug. Only the
 * manual trash path force-removes, and only after the user confirms.
 */
export async function cleanupAgent(s: Session, opts?: { auto?: boolean }): Promise<boolean> {
  if (!hasBackend || !s.id) {
    sessions.update(($s) => $s.filter((x) => x.id !== s.id))
    if (get(selectedId) === s.id) select(null)
    return true
  }
  // Manual path only: confirm before tearing the agent down. Auto-reconcile
  // (refresh-driven) must stay non-blocking. If the agent is linked to a real
  // ticket, remind the user to update the ticket status too — cleanup doesn't
  // touch the tracker, so an in-progress ticket would otherwise go stale.
  if (!opts?.auto) {
    const hasTicket = !s.tid.startsWith('TASK-')
    const srcLabel = s.src === 'linear' ? 'Linear' : 'Jira'
    const ok = await confirmDialog({
      title: 'Clean up agent?',
      message: hasTicket
        ? `This stops ${s.tid} and removes its worktree and branch. It's linked to a ${srcLabel} ticket — remember to update the ticket status there too.`
        : `This stops ${s.tid} and removes its worktree and branch.`,
      confirmLabel: 'Clean up',
      danger: true,
    })
    if (!ok) return false
  }
  // Manual teardown confirmed (or auto-reconcile). Only the MANUAL path
  // (TASK-RAHTX) flips the agent to the optimistic 'tearing-down' loading
  // state + bounces the user to mission control on confirm — auto-reconcile
  // is a background refresh and must stay non-disruptive (no tearing-down
  // flash, no yanking the user off whatever they're viewing). The row is
  // dropped once kill + cleanup finish below.
  const prevStatus = s.status
  const revert = () => {
    if (s.id) patch(s.id, (x) => ({ ...x, status: prevStatus }))
  }
  if (!opts?.auto) {
    if (s.id) patch(s.id, (x) => ({ ...x, status: 'tearing-down' }))
    if (get(selectedId) === s.id) select(null)
  }
  try {
    await killSession(s.id)
    let result = await cleanupSession(s.id, { force: false })
    if (!result.removed) {
      const reason = result.reason ?? 'uncommitted changes or unmerged commits'
      if (opts?.auto) {
        // Never force-destroy a dirty/unmerged worktree during auto-reconcile —
        // that silently discards unpushed agent work. Skip and surface a warning.
        patch(s.id, (x) => ({ ...x, reconcileWarning: reason }))
        revert()
        pushToast('warning', `Kept ${s.tid}: worktree not clean (${reason})`)
        return false
      }
      const ok = await confirmDialog({
        title: 'Force remove worktree?',
        message: `The worktree for ${s.tid} isn't clean. Force-removing discards any uncommitted changes and unmerged commits.`,
        detail: reason,
        confirmLabel: 'Force remove',
        danger: true,
      })
      if (!ok) {
        revert()
        return false
      }
      result = await cleanupSession(s.id, { force: true })
    }
    if (result.removed) {
      removeSession(s.id)
      if (get(selectedId) === s.id) select(null)
      pushToast('success', `Cleaned up ${s.tid}`)
      return true
    }
    revert()
    return false
  } catch (e) {
    revert()
    pushToast('error', cleanError(e))
    return false
  }
}

/** Bring a session's worktree up to date with its repo base. Rebase is the
 *  default; merge is the alternative. Conflicts are aborted backend-side —
 *  the worktree is never left mid-operation. */
export async function updateAgentFromBase(s: Session, mode: WorktreeUpdateMode): Promise<boolean> {
  if (!hasBackend || !s.repo || !s.branch) return false
  const base = repoById(s.repo)?.base ?? 'base'
  try {
    const res = await worktreeUpdateFromBase(s.repo, s.branch, mode)
    const info = res.info
    if (info && s.id) {
      patch(s.id, (x) => ({ ...x, behind: info.behind, add: info.added, del: info.deleted }))
    }
    if (res.stashSaved) {
      pushToast(
        'warning',
        'Uncommitted changes conflicted when re-applying — they are saved in the git stash (`git stash pop` to recover).',
      )
    }
    if (res.updated) {
      pushToast(
        'success',
        mode === 'rebase'
          ? `${s.tid}: rebased ${s.branch} onto ${base}`
          : `${s.tid}: merged ${base} into ${s.branch}`,
      )
      return true
    }
    pushToast('error', res.reason ?? `Could not update ${s.branch} from ${base}`)
    return false
  } catch (e) {
    pushToast('error', cleanError(e))
    return false
  }
}

/** Pull latest tickets, refresh the sidebar list, and tear down agents whose
 *  work has landed and been signed off.
 *  - the linked ticket is now Done in the pulled ticket list (only fires if
 *    the provider returns done tickets — most filter them out of the list,
 *    so this rarely triggers), or
 *  - the session's branch is merged into base per `sessionMerged` (merge
 *    commit naming the branch, squash-equivalent patch, or recorded PR with
 *    zero commits left off base) *and* the linked ticket has been marked
 *    Done (`getTicketStatus` reports `current.type === 'completed'`).
 *  A merged branch alone no longer tears the agent down (TASK-TZGBP): the
 *  user is the final sign-off, since cleanup's `resetTicket` would otherwise
 *  bounce a still-"In Progress" ticket back to To Do the moment the PR
 *  merges. Once the ticket is Done, `resetTicket` is a no-op for both
 *  providers, so the merged+done session can be cleaned safely. */
export async function refreshAndReconcile(): Promise<void> {
  if (!hasBackend) return
  let result
  try {
    result = await listTickets({ page: 1, pageSize: 100 })
  } catch (e) {
    pushToast('error', cleanError(e))
    return
  }
  const dtos = result.tickets
  tickets.set(dtoToTickets(dtos).filter(isStartableTicket))
  ticketsTotalCount.set(result.totalCount)
  ticketsHasMore.set(result.hasMore)
  ticketsPage.set(1)

  const toClean = new Map<string, Session>()
  for (const s of sessionsToReconcile(get(sessions), dtos)) {
    if (s.id) toClean.set(s.id, s)
  }
  for (const s of get(sessions)) {
    if (!s.id || toClean.has(s.id)) continue
    try {
      const probe = await sessionMerged(s.id)
      if (!probe.merged) continue
      const status = await getTicketStatus(s.tid, s.src)
      if (status.current?.type === 'completed') toClean.set(s.id, s)
    } catch {
      // per-session probe failure (offline, repo gone, no real ticket for a
      // draft/TASK-only session) must not break refresh — just keep it
    }
  }
  for (const s of toClean.values()) {
    await cleanupAgent(s, { auto: true })
  }
  await refreshDiffStats().catch(() => {})
}

/** Run the app for a started session via its repo's start command. Opens that
 *  repo's settings if no start command is configured. */
export async function runAppForSession(s: Session): Promise<void> {
  if (!s.repo || !s.branch) return
  const key = appRunKey(s)
  try {
    const res = await runApp({ repoId: s.repo, branch: s.branch })
    if (res.started) {
      if (key) setAppRunning(key, true, res.url)
      if (res.reused) {
        pushToast('success', res.url ? `App already running at ${res.url}` : 'App already running')
      } else if (res.url) {
        pushToast('success', `Launched app at ${res.url}`)
      } else {
        pushToast('success', res.port ? `Launched app on port ${res.port}` : 'Launched app')
      }
    } else if (res.reason === 'no-start-command') {
      pushToast('error', 'No start command set for this repository. Configure it in settings.')
      openRepoSettings(s.repo)
    } else {
      pushToast('error', res.reason ?? 'Could not launch the app')
    }
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Stop then restart the running dev-server app for a session. */
export async function restartAppForSession(s: Session): Promise<void> {
  await stopAppForSession(s)
  await runAppForSession(s)
}
