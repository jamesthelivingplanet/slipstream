import { writable, derived, get } from 'svelte/store'
import type { Filter, Repo, Session, Status, Ticket, BackendKind } from './types'
import type { McpStatusDTO } from '../../electron/shared/contract.js'
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
  worktreeStatus,
  runApp,
  onSessionStatus,
  onSessionPr,
  getMcpStatus as ipcGetMcpStatus,
} from './ipc'
import { pushToast } from './toast'
import { sessionsToReconcile } from './reconcile'
import { isStartableTicket } from './ticketFilter.js'
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

function cleanError(e: unknown): string {
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

export const repos = writable<Repo[]>([])
export const sessions = writable<Session[]>([])
export const tickets = writable<Ticket[]>([])
export const selectedId = writable<string | null>(null)
export const filter = writable<Filter>('all')
export const query = writable<string>('')
export const dialogOpen = writable<boolean>(false)
export const settingsOpen = writable<boolean>(false)
export const settingsRepoId = writable<string | null>(null)

/** True when the viewport is at or below the mobile breakpoint. Synced from App.svelte. */
export const mobile = writable<boolean>(false)

// FLO-56: the header refresh button doubles as the agent-content fetch indicator.
// TicketStatusBar reports its ticket-status fetch here so the header can show loading/resolved.
export const contentLoading = writable<boolean>(false)
// Bumped (to Date.now()) each time a content fetch resolves successfully; header shows a brief check mark.
export const contentResolvedAt = writable<number>(0)
// Bumped by the header refresh button to force a re-fetch of the selected agent's content.
export const contentRefreshNonce = writable<number>(0)

// FLO-61: MCP self-test status, shared between the header dot and the Settings
// Integrations panel so both read the same data without duplicate fetches.
export const mcpStatus = writable<McpStatusDTO | null>(null)
export const mcpChecking = writable(false)

export async function refreshMcpStatus(): Promise<void> {
  if (!hasBackend) return
  mcpChecking.set(true)
  try {
    mcpStatus.set(await ipcGetMcpStatus())
  } catch (e) {
    mcpStatus.set({ up: false, tools: [], checkedAt: Date.now(), error: cleanError(e) })
  } finally {
    mcpChecking.set(false)
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
  sessions.set(
    sessionDTOs.map((dto) => {
      const uiStatus: Status =
        dto.status === 'running' || dto.status === 'needs' ? 'detached' : (dto.status as Status)
      return {
        id: dto.id,
        tid: dto.tid,
        src: 'jira' as const,
        status: uiStatus,
        title: dto.title,
        repo: dto.repoId,
        branch: dto.branch,
        add: 0,
        del: 0,
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
                : 'Detached — open to resume.',
        },
      }
    }),
  )
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
        patch(s.id as string, (x) => ({ ...x, add: info.added, del: info.deleted }))
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
): string {
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
      ago: 'draft',
      prompt,
      description: ticket.description,
      activity: { text: 'Not started.' },
      agentKind,
    },
    ...$s,
  ])
  dialogOpen.set(false)
  select(id)
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
      })
      patch(id, (s) => ({
        ...s,
        id: dto.id,
        branch: dto.branch,
        port: dto.port,
        agentKind: dto.agentKind,
        repo: repoId,
        status: dto.status,
      }))
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

/**
 * Subscribe to the backend's global session-status broadcast and mirror every
 * transition into the store for ALL sessions (not just the selected one).
 * This keeps the Agent list + filters live without each TerminalView needing
 * its own per-terminal subscription. `setSessionStatus` already dedupes desktop
 * notifications via its prev-check, so this is safe even though TerminalView no
 * longer subscribes.
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

/** Update the PR/MR URL of the session identified by its backend UUID. */
export function setSessionPrUrl(id: string, prUrl: string) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, prUrl } : s)))
}

/** Update the status of the session identified by its backend UUID. */
export function setSessionStatus(id: string, status: Status) {
  let prev: Status | undefined
  let title: string | undefined
  sessions.update(($s) =>
    $s.map((s) => {
      if (s.id !== id) return s
      prev = s.status
      title = s.title
      return { ...s, status }
    }),
  )
  if (prev !== status && (status === 'needs' || status === 'done')) {
    notifyTransition(status, title)
  }
}

/** Best-effort desktop notification; silently no-ops if unavailable/denied. */
function notifyTransition(status: 'needs' | 'done', title?: string) {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') {
      if (Notification.permission !== 'denied') void Notification.requestPermission()
      return
    }
    const heading = status === 'needs' ? 'Agent needs you' : 'Agent finished'
    new Notification(heading, { body: title ?? '' })
  } catch {
    /* notifications unsupported — ignore */
  }
}

/** Remove a session by its backend UUID from the store. */
export function removeSession(id: string) {
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
      if (!confirm(`Worktree not clean: ${reason}. Force remove?`)) return false
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

/** Pull latest tickets, refresh the sidebar list, and tear down agents whose ticket is now Done. */
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
  for (const s of sessionsToReconcile(get(sessions), dtos)) {
    await cleanupAgent(s, { auto: true })
  }
  await refreshDiffStats().catch(() => {})
}

/** Run the app for a started session via its repo's start command. Opens that
 *  repo's settings if no start command is configured. */
export async function runAppForSession(s: Session): Promise<void> {
  if (!s.repo || !s.branch) return
  try {
    const res = await runApp({ repoId: s.repo, branch: s.branch })
    if (res.started) {
      pushToast('success', res.port ? `Launched app on port ${res.port}` : 'Launched app')
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
