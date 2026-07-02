import { describe, it, expect, beforeEach, vi } from 'vitest'
import { get } from 'svelte/store'
import { isStartableTicket } from './ticketFilter.js'

vi.mock('./ipc', () => ({
  hasBackend: true,
  listRepos: vi.fn(),
  listTickets: vi.fn(),
  listSessions: vi.fn(),
  pickAndRegisterRepo: vi.fn(),
  registerRepo: vi.fn(),
  registerRepoByUrl: vi.fn(),
  removeRepo: vi.fn(),
  startSession: vi.fn(),
  killSession: vi.fn(),
  cleanupSession: vi.fn(),
  worktreeStatus: vi.fn(),
  runApp: vi.fn(),
  onSessionStatus: vi.fn(),
  onSessionPr: vi.fn(),
  getMcpStatus: vi.fn(),
}))

import { cleanupSession, killSession } from './ipc'
import {
  sessions,
  tickets,
  createBlankAgent,
  createAgentFromTicket,
  setSessionPrUrl,
  cleanupAgent,
  contentLoading,
  contentResolvedAt,
  contentRefreshNonce,
  select,
  selectedId,
  setSessionStatus,
  removeSession,
  selected,
} from './stores.js'
import { toasts } from './toast.js'
import type { Ticket, Session } from './types.js'

describe('isStartableTicket', () => {
  it('keeps a backlog ticket (type backlog, done false)', () => {
    expect(
      isStartableTicket({ done: false, status: { id: '1', name: 'Backlog', type: 'backlog' } }),
    ).toBe(true)
  })

  it('keeps a ticket with no status type (done false)', () => {
    expect(isStartableTicket({ done: false, status: undefined })).toBe(true)
  })

  it('keeps a ticket with status type unstarted', () => {
    expect(
      isStartableTicket({ done: false, status: { id: '2', name: 'Todo', type: 'unstarted' } }),
    ).toBe(true)
  })

  it('excludes a ticket with done: true', () => {
    expect(isStartableTicket({ done: true, status: undefined })).toBe(false)
  })

  it('excludes a ticket with status.type === started (In Progress)', () => {
    expect(
      isStartableTicket({ done: false, status: { id: '3', name: 'In Progress', type: 'started' } }),
    ).toBe(false)
  })

  it('excludes a ticket with status.type === canceled', () => {
    expect(
      isStartableTicket({ done: false, status: { id: '4', name: 'Canceled', type: 'canceled' } }),
    ).toBe(false)
  })
})

describe('createBlankAgent', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
  })

  it('returns a client-generated UUID and adds an idle session to the store', () => {
    const id = createBlankAgent('Do thing', 'go')
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    const all = get(sessions)
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(id)
    expect(all[0].tid).toMatch(/^TASK-/)
    expect(all[0].title).toBe('Do thing')
    expect(all[0].status).toBe('idle')
  })

  it('honours an explicit tid', () => {
    const id = createBlankAgent('X', 'go', 'FLO-9')
    expect(get(sessions)[0].tid).toBe('FLO-9')
    expect(get(sessions)[0].id).toBe(id)
  })
})

describe('createAgentFromTicket', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
  })

  it('returns a client-generated id, seeds a session, and consumes the ticket', () => {
    const t: Ticket = { tid: 'FLO-34', src: 'linear', title: 'Consolidate', repo: '', done: false }
    tickets.set([t])
    const id = createAgentFromTicket(t, 'Begin implementing FLO-34.')
    expect(get(sessions)[0]).toMatchObject({
      id,
      tid: 'FLO-34',
      title: 'Consolidate',
      status: 'idle',
    })
    expect(get(tickets)).toHaveLength(0)
  })
})

describe('FLO-75 client UUID identity', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
    selectedId.set(null)
  })

  it('isolates selection and status for two drafts of the same ticket', () => {
    const t: Ticket = { tid: 'FLO-1', src: 'linear', title: 'Dup', repo: '', done: false }
    const id1 = createAgentFromTicket(t, 'go')
    const id2 = createAgentFromTicket(t, 'go')
    expect(id1).not.toBe(id2)
    const all = get(sessions)
    expect(all.filter((s) => s.tid === 'FLO-1')).toHaveLength(2)
    // selection isolated
    select(id1)
    expect(get(selected)?.id).toBe(id1)
    // status update to one does not touch the other
    setSessionStatus(id2, 'done')
    const after = get(sessions)
    expect(after.find((s) => s.id === id1)?.status).toBe('idle')
    expect(after.find((s) => s.id === id2)?.status).toBe('done')
    // selection still points at id1 and reflects its (unchanged) status
    expect(get(selected)?.status).toBe('idle')
  })

  it('does not leak status from a recreated agent onto the removed old session', () => {
    const t: Ticket = { tid: 'FLO-2', src: 'linear', title: 'Recreate', repo: '', done: false }
    const id1 = createAgentFromTicket(t, 'go')
    setSessionStatus(id1, 'running')
    removeSession(id1)
    const id2 = createAgentFromTicket(t, 'go')
    expect(id2).not.toBe(id1)
    setSessionStatus(id2, 'done')
    const all = get(sessions)
    expect(all.find((s) => s.id === id1)).toBeUndefined()
    expect(all.find((s) => s.id === id2)?.status).toBe('done')
    expect(all.filter((s) => s.tid === 'FLO-2')).toHaveLength(1)
  })
})

describe('setSessionPrUrl', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
  })

  it('updates the prUrl of the matching session by backend id', () => {
    sessions.set([
      {
        id: 'abc',
        tid: 'FLO-1',
        src: 'linear',
        status: 'running',
        title: 'A',
        repo: null,
        branch: null,
        add: 0,
        del: 0,
        ago: '',
        activity: { text: '' },
      },
      {
        id: 'def',
        tid: 'FLO-2',
        src: 'linear',
        status: 'running',
        title: 'B',
        repo: null,
        branch: null,
        add: 0,
        del: 0,
        ago: '',
        activity: { text: '' },
      },
    ])
    setSessionPrUrl('abc', 'https://github.com/acme/repo/pull/1')
    const all = get(sessions)
    expect(all.find((s) => s.id === 'abc')?.prUrl).toBe('https://github.com/acme/repo/pull/1')
    expect(all.find((s) => s.id === 'def')?.prUrl).toBeUndefined()
  })

  it('leaves the store unchanged when no session matches the id', () => {
    sessions.set([
      {
        id: 'abc',
        tid: 'FLO-1',
        src: 'linear',
        status: 'running',
        title: 'A',
        repo: null,
        branch: null,
        add: 0,
        del: 0,
        ago: '',
        activity: { text: '' },
      },
    ])
    setSessionPrUrl('zzz', 'https://gitlab.com/acme/repo/-/merge_requests/1')
    expect(get(sessions)[0].prUrl).toBeUndefined()
  })
})

describe('FLO-56 content stores', () => {
  it('default to false/0/0', () => {
    expect(get(contentLoading)).toBe(false)
    expect(get(contentResolvedAt)).toBe(0)
    expect(get(contentRefreshNonce)).toBe(0)
  })
})

describe('cleanupAgent auto-reconcile', () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'u1',
      tid: 'A',
      src: 'linear',
      status: 'done',
      title: 'Some task',
      repo: 'repo1',
      branch: 'A-branch',
      add: 0,
      del: 0,
      ago: '',
      activity: { text: '' },
      ...overrides,
    } as Session
  }

  beforeEach(() => {
    sessions.set([makeSession()])
    toasts.set([])
    vi.clearAllMocks()
    vi.mocked(killSession).mockResolvedValue(undefined)
  })

  it('skips (does not force-remove) a dirty/unmerged worktree and surfaces a warning', async () => {
    vi.mocked(cleanupSession).mockResolvedValue({ removed: false, reason: '2 files changed' })
    const session = makeSession()

    const result = await cleanupAgent(session, { auto: true })

    expect(result).toBe(false)
    expect(cleanupSession).toHaveBeenCalledTimes(1)
    for (const call of vi.mocked(cleanupSession).mock.calls) {
      expect(call[1]).toEqual({ force: false })
    }

    const stored = get(sessions).find((s) => s.tid === 'A')
    expect(stored).toBeDefined()
    expect(stored?.reconcileWarning).toBe('2 files changed')

    const warningToast = get(toasts).find((t) => t.type === 'warning')
    expect(warningToast).toBeDefined()
  })

  it('still auto-removes a clean worktree', async () => {
    vi.mocked(cleanupSession).mockResolvedValue({ removed: true })
    const session = makeSession()

    const result = await cleanupAgent(session, { auto: true })

    expect(result).toBe(true)
    expect(get(sessions).find((s) => s.tid === 'A')).toBeUndefined()
    expect(cleanupSession).toHaveBeenCalledTimes(1)
    expect(cleanupSession).toHaveBeenCalledWith('u1', { force: false })
  })
})
