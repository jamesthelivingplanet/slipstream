import { writable, get } from 'svelte/store'
import type { Session, Status } from '../types'
import type { RepoDTO, TicketDTO, SessionDTO } from '../../../electron/shared/contract.js'
import {
  hasBackend,
  listRepos,
  listTickets,
  listSessions,
  sessionMerged,
  getTicketStatus,
  onSessionStatus,
  onSessionPr,
  onConnectionChange,
} from '../ipc'
import { pushToast } from '../toast'
import { sessionsToReconcile } from '../reconcile'
import { isStartableTicket } from '../ticketFilter.js'
import { cleanError } from './errors.js'
import { sessions } from './sessionsCore.js'
import { connected } from './ui.js'
import { repos } from './repos.js'
import { tickets, ticketsTotalCount, ticketsHasMore, ticketsPage, dtoToTickets } from './tickets.js'
import {
  mergeSessionsPreservingDrafts,
  loadPersistedDrafts,
  refreshDiffStats,
  setSessionStatus,
  setSessionPrUrl,
  cleanupAgent,
} from './sessions.js'

export const initialLoadLoading = writable<boolean>(true)
export const initialLoadError = writable<'repos' | 'tickets' | 'sessions' | null>(null)

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

export function retryInitialLoad(): void {
  initFromBackend()
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
