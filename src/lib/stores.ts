import { writable, derived, get } from 'svelte/store'
import type { Filter, Session, Status, Ticket } from './types'
import { branchFor, initialSessions, initialTickets } from './mock'

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

function patch(tid: string, fn: (s: Session) => Session) {
  sessions.update(($s) => $s.map((s) => (s.tid === tid ? fn(s) : s)))
}

export function select(tid: string | null) {
  selectedId.set(tid)
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

export function startAgent(tid: string, repoId: string, prompt: string) {
  const s = get(sessions).find((x) => x.tid === tid)
  if (!s) return
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

export function resolveNeedsInput(tid: string) {
  patch(tid, (s) => ({ ...s, status: 'running', activity: { text: 'Applying decision, writing the fix…' } }))
}
