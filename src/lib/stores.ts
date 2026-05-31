import { writable, derived, get } from 'svelte/store'
import type { Filter, Repo, Session, Status, Ticket } from './types'
import { branchFor, initialSessions, initialTickets, repos as mockRepos } from './mock'
import {
  hasBackend,
  listRepos,
  listTickets,
  pickAndRegisterRepo,
  startSession,
} from './ipc'

export const repos = writable<Repo[]>([...mockRepos])
export const sessions = writable<Session[]>([...initialSessions])
export const tickets = writable<Ticket[]>([...initialTickets])
export const selectedId = writable<string | null>(null)
export const filter = writable<Filter>('all')
export const query = writable<string>('')
export const dialogOpen = writable<boolean>(false)

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

  tickets.set(
    ticketDTOs.map((d) => ({
      tid: d.tid,
      src: d.src as 'jira' | 'linear',
      title: d.title,
      repo: d.repoHint ?? '',
    })),
  )

  // Real sessions start empty; they are created via startAgent.
  sessions.set([])
}

/** Open the native folder picker and register the chosen repo. */
export async function registerRepo(): Promise<void> {
  const dto = await pickAndRegisterRepo()
  if (!dto) return
  repos.update(($r) => [
    ...$r,
    { id: dto.id, org: dto.org, name: dto.name, base: dto.base },
  ])
}

export function createAgentFromTicket(ticket: Ticket, prompt: string) {
  tickets.update(($t) => $t.filter((t) => t.tid !== ticket.tid))
  sessions.update(($s) => [
    {
      tid: ticket.tid, src: ticket.src, status: 'idle' as Status, title: ticket.title,
      repo: null, suggestedRepo: ticket.repo, branch: null, add: 0, del: 0, ago: 'draft',
      prompt, activity: { text: 'Not started.' },
    },
    ...$s,
  ])
  dialogOpen.set(false)
  select(ticket.tid)
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
      const dto = await startSession({ tid, title: s.title, prompt, repoId })
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

/** Update the status of the session identified by its backend UUID. */
export function setSessionStatus(id: string, status: Status) {
  patchById(id, (s) => ({ ...s, status }))
}

/** Remove a session by its backend UUID from the store. */
export function removeSession(id: string) {
  sessions.update(($s) => $s.filter((s) => s.id !== id))
}

export function resolveNeedsInput(tid: string) {
  patch(tid, (s) => ({ ...s, status: 'running', activity: { text: 'Applying decision, writing the fix…' } }))
}
