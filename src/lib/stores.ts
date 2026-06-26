import { writable, derived, get } from 'svelte/store'
import type { Filter, Repo, Session, Status, Ticket } from './types'
import { branchFor } from './branch'
import {
  hasBackend,
  listRepos,
  listTickets,
  listSessions,
  pickAndRegisterRepo,
  registerRepo as ipcRegisterRepo,
  removeRepo,
  startSession,
  killSession,
  cleanupSession,
  worktreeStatus,
  runApp,
  onSessionStatus,
} from './ipc'
import { pushToast } from './toast'
import { sessionsToReconcile } from './reconcile'
import { isStartableTicket } from './ticketFilter.js'
export { sessionsToReconcile } from './reconcile'
export { isStartableTicket } from './ticketFilter.js'

function dtoToTickets(dtos: { tid: string; src: string; title: string; repoHint?: string; description?: string; status?: { id: string; name: string; type?: string }; done: boolean }[]): Ticket[] {
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
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Uncaught\s+)?Error:\s*/, '')
    .trim() || 'Something went wrong'
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

export const selected = derived([sessions, selectedId], ([$sessions, $id]) =>
  $id ? $sessions.find((s) => s.tid === $id) ?? null : null,
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

function patch(tid: string, fn: (s: Session) => Session) {
  sessions.update(($s) => $s.map((s) => (s.tid === tid ? fn(s) : s)))
}

function patchById(id: string, fn: (s: Session) => Session) {
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
    sessionDTOs.map((dto) => ({
      id: dto.id,
      tid: dto.tid,
      src: 'jira' as const,
      status: (dto.status === 'running' || dto.status === 'needs') ? 'detached' : dto.status,
      title: dto.title,
      repo: dto.repoId,
      branch: dto.branch,
      add: 0,
      del: 0,
      ago: '',
      prompt: dto.prompt,
      port: dto.port,
      activity: { text: 'Detached — open to resume.' },
    }))
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
        patchById(s.id as string, (x) => ({ ...x, add: info.added, del: info.deleted }))
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

/** Open the native folder picker and register the chosen repo. */
export async function registerRepo(): Promise<void> {
  try {
    const dto = await pickAndRegisterRepo()
    if (!dto) return
    repos.update(($r) => [...$r, { id: dto.id, org: dto.org, name: dto.name, base: dto.base }])
    pushToast('success', `Imported ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Web fallback: register a repo by typing an absolute path directly. */
export async function registerRepoByPath(absPath: string): Promise<void> {
  try {
    const dto = await ipcRegisterRepo(absPath)
    repos.update(($r) => [...$r, { id: dto.id, org: dto.org, name: dto.name, base: dto.base }])
    pushToast('success', `Imported ${dto.org}/${dto.name} · ${dto.base}`)
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

export function createAgentFromTicket(ticket: Ticket, prompt: string): string {
  tickets.update(($t) => $t.filter((t) => t.tid !== ticket.tid))
  sessions.update(($s) => [
    {
      tid: ticket.tid, src: ticket.src, status: 'idle' as Status, title: ticket.title,
      repo: null, suggestedRepo: ticket.repo, branch: null, add: 0, del: 0, ago: 'draft',
      prompt, description: ticket.description, activity: { text: 'Not started.' },
    },
    ...$s,
  ])
  dialogOpen.set(false)
  select(ticket.tid)
  return ticket.tid
}

export function createBlankAgent(title: string, prompt: string, tid: string = `TASK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`): string {
  sessions.update(($s) => [
    { tid, src: 'jira', status: 'idle', title, repo: null, branch: null,
      add: 0, del: 0, ago: 'draft', prompt, activity: { text: 'Not started.' } },
    ...$s,
  ])
  dialogOpen.set(false)
  select(tid)
  return tid
}

export async function startAgent(tid: string, repoId: string, prompt: string) {
  const s = get(sessions).find((x) => x.tid === tid)
  if (!s) return

  if (hasBackend) {
    // Optimistically update to show activity before the async call resolves.
    patch(tid, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      status: 'running',
      ago: 'just now',
      activity: { text: 'Creating worktree & starting claude…' },
    }))
    try {
      const dto = await startSession({ tid, title: s.title, prompt, repoId, description: s.description })
      patch(tid, (s) => ({
        ...s,
        id: dto.id,
        branch: dto.branch,
        port: dto.port,
        repo: repoId,
        status: dto.status,
      }))
    } catch (err) {
      patch(tid, (s) => ({
        ...s,
        status: 'errored',
        activity: { text: String(err) },
      }))
    }
  } else {
    // Mock path — simulate immediately.
    patch(tid, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      branch: branchFor(s.tid, s.title),
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

export function resolveNeedsInput(tid: string) {
  patch(tid, (s) => ({ ...s, status: 'running', activity: { text: 'Applying decision, writing the fix…' } }))
}

/**
 * Shared agent teardown: kill the PTY, remove worktree+branch via the backend,
 * and drop it from the sidebar. `auto` (refresh-driven) force-removes without
 * prompting; the manual trash path confirms before forcing a dirty/unmerged tree.
 */
export async function cleanupAgent(s: Session, opts?: { auto?: boolean }): Promise<boolean> {
  if (!hasBackend || !s.id) {
    sessions.update(($s) => $s.filter((x) => x.tid !== s.tid))
    if (get(selectedId) === s.tid) select(null)
    return true
  }
  try {
    await killSession(s.id)
    let result = await cleanupSession(s.id, { force: false })
    if (!result.removed) {
      const force = opts?.auto || confirm(`Worktree not clean: ${result.reason ?? 'unknown reason'}. Force remove?`)
      if (!force) return false
      result = await cleanupSession(s.id, { force: true })
    }
    if (result.removed) {
      removeSession(s.id)
      if (get(selectedId) === s.tid) select(null)
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
