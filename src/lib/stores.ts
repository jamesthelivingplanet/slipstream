import { writable, derived, get } from 'svelte/store'
import type { Filter, Repo, Session, Status, Ticket, BackendKind, Source } from './types'
import type {
  CliStatusDTO,
  DiagnosticsDTO,
  SessionDTO,
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
  stopApp,
  appStatus,
  onSessionStatus,
  onSessionPr,
  onConnectionChange,
  getCliStatus as ipcGetCliStatus,
  getDiagnostics as ipcGetDiagnostics,
} from './ipc'
import { pushToast } from './toast'
import { sessionsToReconcile } from './reconcile'
import { isStartableTicket } from './ticketFilter.js'
import type { ReviewComment } from './review.js'
export { sessionsToReconcile } from './reconcile'
export { isStartableTicket } from './ticketFilter.js'

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
  const uiStatus: Status =
    dto.status === 'running' || dto.status === 'needs' ? 'detached' : (dto.status as Status)
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

export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return (
    msg
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(Uncaught\s+)?Error:\s*/, '')
      .trim() || 'Something went wrong'
  )
}

export function openRepoSettings(repoId: string) {
  settingsRepoId.set(repoId)
  settingsOpen.set(true)
}

/** In-app replacement for window.confirm — surfaces via <ConfirmDialog />. */
export interface ConfirmRequest {
  title: string
  message: string
  detail?: string // e.g. the dirty/unmerged reason string
  confirmLabel?: string // default "Confirm"
  cancelLabel?: string // default "Cancel"
  danger?: boolean
}
export const confirmState = writable<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(
  null,
)
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => confirmState.set({ ...req, resolve }))
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

/** True when the viewport is at or below the mobile breakpoint. Synced from App.svelte. */
export const mobile = writable<boolean>(false)

/** Height (px) of the on-screen keyboard overlapping the viewport (mobile). Synced from App.svelte. */
export const keyboardInset = writable<number>(0)

/** True when the viewport is at or below the drawer breakpoint (≤900px), meaning
 *  the agent list sidebar should be a toggleable overlay drawer. Synced from App.svelte. */
export const drawer = writable<boolean>(false)

// FLO-56: the header refresh button doubles as the agent-content fetch indicator.
// TicketStatusBar reports its ticket-status fetch here so the header can show loading/resolved.
export const contentLoading = writable<boolean>(false)
// Bumped (to Date.now()) each time a content fetch resolves successfully; header shows a brief check mark.
export const contentResolvedAt = writable<number>(0)
// Bumped by the header refresh button to force a re-fetch of the selected agent's content.
export const contentRefreshNonce = writable<number>(0)

// FLO-61: slipstream CLI self-test status, shared between the header dot and the Settings
// Integrations panel so both read the same data without duplicate fetches.
export const cliStatus = writable<CliStatusDTO | null>(null)
export const cliChecking = writable(false)

export async function refreshCliStatus(): Promise<void> {
  if (!hasBackend) return
  cliChecking.set(true)
  try {
    cliStatus.set(await ipcGetCliStatus())
  } catch (e) {
    cliStatus.set({ up: false, commands: [], checkedAt: Date.now(), error: cleanError(e) })
  } finally {
    cliChecking.set(false)
  }
}

// FLO-81: Settings → Diagnostics tab data — daemon/version/repo-consistency info.
export const diagnostics = writable<DiagnosticsDTO | null>(null)
export const diagChecking = writable(false)

export async function refreshDiagnostics(): Promise<void> {
  if (!hasBackend) return
  diagChecking.set(true)
  try {
    diagnostics.set(await ipcGetDiagnostics())
  } catch {
    diagnostics.set(null)
  } finally {
    diagChecking.set(false)
  }
}

export const selected = derived([sessions, selectedId], ([$sessions, $id]) =>
  $id ? ($sessions.find((s) => s.id === $id) ?? null) : null,
)

export const counts = derived(sessions, ($sessions) => {
  const c = { all: $sessions.length, needs: 0, running: 0, done: 0 } as Record<string, number>
  for (const s of $sessions) c[s.status] = (c[s.status] ?? 0) + 1
  return c
})

export const visible = derived([sessions, filter, query], ([$sessions, $filter, $query]) => {
  const q = $query.toLowerCase()
  return $sessions.filter(
    (s) =>
      ($filter === 'all' || s.status === $filter) &&
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
  if (!hasBackend) return

  const [repoDTOs, ticketDTOs] = await Promise.all([listRepos(), listTickets()])

  repos.set(
    repoDTOs.map((d) => ({
      id: d.id,
      org: d.org,
      name: d.name,
      base: d.base,
    })),
  )

  tickets.set(dtoToTickets(ticketDTOs).filter(isStartableTicket))

  const sessionDTOs = await listSessions()
  sessions.set(sessionDTOs.map(dtoToSession))
  await refreshDiffStats().catch(() => {})
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
  try {
    const dtos = await listTickets()
    tickets.set(dtoToTickets(dtos).filter(isStartableTicket))
  } catch (e) {
    pushToast('error', cleanError(e))
  }
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
) {
  const s = get(sessions).find((x) => x.id === id)
  if (!s) return

  if (hasBackend) {
    // Optimistically update to show activity before the async call resolves.
    patch(id, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      status: 'running',
      ago: 'just now',
      activity: { text: 'Creating worktree & starting claude…' },
    }))
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
 * a plain refresh (no clever merging) is the simplest way to reconcile, and
 * matches what a manual remount already did before reconnect handling existed.
 */
export function subscribeConnectionChange(): () => void {
  if (!hasBackend) return () => {}
  let wasDisconnected = false
  return onConnectionChange((connected) => {
    if (!connected) {
      wasDisconnected = true
      return
    }
    if (!wasDisconnected) return
    wasDisconnected = false
    listSessions()
      .then((dtos) => sessions.set(dtos.map(dtoToSession)))
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
  try {
    await killSession(s.id)
    let result = await cleanupSession(s.id, { force: false })
    if (!result.removed) {
      const reason = result.reason ?? 'uncommitted changes or unmerged commits'
      if (opts?.auto) {
        // Never force-destroy a dirty/unmerged worktree during auto-reconcile —
        // that silently discards unpushed agent work. Skip and surface a warning.
        patch(s.id, (x) => ({ ...x, reconcileWarning: reason }))
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
      if (!ok) return false
      result = await cleanupSession(s.id, { force: true })
    }
    if (result.removed) {
      removeSession(s.id)
      if (get(selectedId) === s.id) select(null)
      pushToast('success', `Cleaned up ${s.tid}`)
      return true
    }
    return false
  } catch (e) {
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
  let dtos
  try {
    dtos = await listTickets()
  } catch (e) {
    pushToast('error', cleanError(e))
    return
  }
  tickets.set(dtoToTickets(dtos).filter(isStartableTicket))

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

/** Sessions with a currently running dev-server app, keyed by "<repo> <branch>"
 *  (matching the backend's app-runner key). Svelte 4 reactivity on a Set needs
 *  reassignment, so `add`/`remove` always replace the Set instance. */
export const runningApps = writable<Set<string>>(new Set())

/** Stable key for the runningApps set. Returns null when repo/branch aren't set yet. */
export function appRunKey(s: Session): string | null {
  return s.repo && s.branch ? `${s.repo} ${s.branch}` : null
}

/** Tailnet URLs of running apps (from `tailscale serve`), keyed like runningApps. */
export const appUrls = writable<Record<string, string>>({})

function setAppRunning(key: string, running: boolean, url?: string) {
  runningApps.update(($r) => {
    const next = new Set($r)
    if (running) next.add(key)
    else next.delete(key)
    return next
  })
  appUrls.update(($u) => {
    const next = { ...$u }
    if (running && url) next[key] = url
    else delete next[key]
    return next
  })
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

/** Stop the running dev-server app for a session. */
export async function stopAppForSession(s: Session): Promise<void> {
  if (!hasBackend || !s.repo || !s.branch) return
  const key = appRunKey(s)
  try {
    const res = await stopApp({ repoId: s.repo, branch: s.branch })
    if (res.stopped) {
      if (key) setAppRunning(key, false)
      pushToast('success', 'Stopped app')
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

/** Hydrate runningApps for a session from the backend — call when a session's
 *  terminal is opened/changed so the Run/Stop buttons reflect reality after reload. */
export async function refreshAppStatus(s: Session): Promise<void> {
  if (!hasBackend || !s.repo || !s.branch) return
  const key = appRunKey(s)
  if (!key) return
  try {
    const res = await appStatus({ repoId: s.repo, branch: s.branch })
    setAppRunning(key, res.running, res.url)
  } catch {
    // leave existing state on failure
  }
}

/** Draft review comments accumulated in the Diff view, keyed by session id, so
 *  they survive tab toggles and the `{#key $selected.id}` remount. In-memory
 *  only (lost on reload). Svelte 4 reactivity needs reassignment, so every
 *  action below replaces the record/array instances rather than mutating. */
export const reviewComments = writable<Record<string, ReviewComment[]>>({})

/** Append a review comment for the given session. */
export function addReviewComment(sessionId: string, c: ReviewComment): void {
  reviewComments.update(($r) => ({
    ...$r,
    [sessionId]: [...($r[sessionId] ?? []), c],
  }))
}

/** Remove a single review comment (by id) for the given session. No-op if the
 *  session has no draft comments (avoids creating a stray empty array entry). */
export function removeReviewComment(sessionId: string, commentId: string): void {
  reviewComments.update(($r) => {
    const existing = $r[sessionId]
    if (!existing) return $r
    return { ...$r, [sessionId]: existing.filter((c) => c.id !== commentId) }
  })
}

/** Discard all draft review comments for the given session (e.g. after a
 *  successful submit, or via the Discard-all confirm). */
export function clearReviewComments(sessionId: string): void {
  reviewComments.update(($r) => {
    const next = { ...$r }
    delete next[sessionId]
    return next
  })
}
