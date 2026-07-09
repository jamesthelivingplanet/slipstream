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
  sessionMerged: vi.fn(),
  worktreeStatus: vi.fn(),
  runApp: vi.fn(),
  stopApp: vi.fn(),
  appStatus: vi.fn(),
  onSessionStatus: vi.fn(),
  onSessionPr: vi.fn(),
  getMcpStatus: vi.fn(),
}))

import {
  cleanupSession,
  killSession,
  runApp,
  stopApp,
  listTickets,
  sessionMerged,
  startSession,
} from './ipc'
import {
  sessions,
  tickets,
  repos,
  dialogOpen,
  createBlankAgent,
  createAgentFromTicket,
  startAgentsFromTickets,
  discardDraft,
  setSessionPrUrl,
  cleanupAgent,
  contentLoading,
  contentResolvedAt,
  contentRefreshNonce,
  select,
  selectedId,
  setSessionStatus,
  removeSession,
  refreshAndReconcile,
  selected,
  confirmState,
  runningApps,
  appRunKey,
  runAppForSession,
  stopAppForSession,
  dtoToSession,
  reviewComments,
  addReviewComment,
  removeReviewComment,
  clearReviewComments,
} from './stores.js'
import { toasts } from './toast.js'
import type { Ticket, Session } from './types.js'
import type { SessionDTO } from '../../electron/shared/contract.js'
import type { ReviewComment } from './review.js'

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

  it('FLO-95: with { select: false } does not touch selection or close the dialog', () => {
    const t: Ticket = { tid: 'FLO-95', src: 'linear', title: 'Batch', repo: '', done: false }
    tickets.set([t])
    selectedId.set('some-other-id')
    dialogOpen.set(true)

    const id = createAgentFromTicket(t, 'go', 'claude-code', { select: false })

    expect(get(sessions).find((s) => s.id === id)).toBeDefined()
    expect(get(selectedId)).toBe('some-other-id')
    expect(get(dialogOpen)).toBe(true)
  })
})

describe('discardDraft', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
    selectedId.set(null)
    vi.clearAllMocks()
  })

  it('only acts on an idle draft, leaving non-idle sessions untouched', () => {
    const t: Ticket = { tid: 'FLO-40', src: 'linear', title: 'Not idle', repo: '', done: false }
    const id = createAgentFromTicket(t, 'go')
    const running = { ...get(sessions).find((s) => s.id === id)!, status: 'running' as const }
    sessions.set([running])

    discardDraft(running)

    expect(get(sessions)).toHaveLength(1)
    expect(get(sessions)[0].id).toBe(id)
  })

  it('removes the draft session and deselects it when selected', () => {
    const t: Ticket = { tid: 'FLO-41', src: 'linear', title: 'Bye', repo: '', done: false }
    const id = createAgentFromTicket(t, 'go')
    select(id)

    const draft = get(sessions).find((s) => s.id === id)!
    discardDraft(draft)

    expect(get(sessions).find((s) => s.id === id)).toBeUndefined()
    expect(get(selectedId)).toBeNull()
  })

  it('restores the ticket via refreshTickets when the draft came from a real ticket', async () => {
    const t: Ticket = { tid: 'FLO-42', src: 'linear', title: 'Restore me', repo: '', done: false }
    tickets.set([t])
    const id = createAgentFromTicket(t, 'go')
    expect(get(tickets)).toHaveLength(0)

    vi.mocked(listTickets).mockResolvedValue([
      { id: 'FLO-42', tid: 'FLO-42', src: 'linear', title: 'Restore me', done: false },
    ])

    const draft = get(sessions).find((s) => s.id === id)!
    discardDraft(draft)
    await Promise.resolve()
    await Promise.resolve()

    expect(listTickets).toHaveBeenCalled()
    expect(get(tickets).find((x) => x.tid === 'FLO-42')).toBeDefined()
  })

  it('does not remove a blank-agent draft twice or throw when it has no suggestedRepo', () => {
    const id = createBlankAgent('Blank', 'go')
    const draft = get(sessions).find((s) => s.id === id)!

    discardDraft(draft)

    expect(get(sessions).find((s) => s.id === id)).toBeUndefined()
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

  it('manual path: not-clean worktree opens the confirm dialog and resolving false does not force-remove', async () => {
    vi.mocked(cleanupSession).mockResolvedValue({ removed: false, reason: '2 files changed' })
    const session = makeSession()

    const pending = cleanupAgent(session, { auto: false })

    // Wait for the confirmDialog request to be registered (killSession + cleanupSession
    // resolve as microtasks first).
    for (let i = 0; i < 10 && get(confirmState) === null; i++) {
      await Promise.resolve()
    }
    const req = get(confirmState)
    expect(req).not.toBeNull()
    expect(req?.detail).toBe('2 files changed')

    req?.resolve(false)
    confirmState.set(null)
    const result = await pending

    expect(result).toBe(false)
    expect(cleanupSession).toHaveBeenCalledTimes(1)
    expect(get(sessions).find((s) => s.tid === 'A')).toBeDefined()
  })
})

describe('dtoToSession (FLO-83 src round-trip)', () => {
  it('maps a linear-sourced session DTO to a Session with src intact', () => {
    const dto: SessionDTO = {
      id: 's1',
      tid: 'T-1',
      title: 't',
      prompt: 'p',
      repoId: 'r',
      branch: 'b',
      status: 'idle',
      createdAt: 0,
      src: 'linear',
    }
    expect(dtoToSession(dto).src).toBe('linear')
  })

  it('defaults a legacy session DTO with no persisted src to jira', () => {
    const dto: SessionDTO = {
      id: 's2',
      tid: 'T-2',
      title: 't',
      prompt: 'p',
      repoId: 'r',
      branch: 'b',
      status: 'idle',
      createdAt: 0,
    }
    expect(dtoToSession(dto).src).toBe('jira')
  })

  it('FLO-95: keeps a queued DTO as queued with the queued activity text', () => {
    const dto: SessionDTO = {
      id: 's3',
      tid: 'T-3',
      title: 't',
      prompt: 'p',
      repoId: 'r',
      branch: 'b',
      status: 'queued',
      createdAt: 0,
      src: 'linear',
    }
    const s = dtoToSession(dto)
    expect(s.status).toBe('queued')
    expect(s.activity.text).toBe('Queued — will start when an agent slot frees.')
  })
})

describe('startAgentsFromTickets (FLO-95 batch launch)', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
    repos.set([{ id: 'repo1', org: 'acme', name: 'widgets', base: 'main' }])
    selectedId.set(null)
    dialogOpen.set(false)
    vi.clearAllMocks()
  })

  it('only starts tickets whose repo hint resolves to a registered repo', async () => {
    const withRepo: Ticket = {
      tid: 'FLO-1',
      src: 'linear',
      title: 'Has repo',
      repo: 'repo1',
      done: false,
    }
    const withoutRepo: Ticket = {
      tid: 'FLO-2',
      src: 'linear',
      title: 'No repo',
      repo: 'unknown-repo',
      done: false,
    }
    vi.mocked(startSession).mockResolvedValue({
      id: 'started-1',
      tid: 'FLO-1',
      title: 'Has repo',
      prompt: 'Begin implementing FLO-1.',
      repoId: 'repo1',
      branch: 'FLO-1-branch',
      status: 'running',
      createdAt: 0,
      src: 'linear',
    })

    const n = await startAgentsFromTickets([withRepo, withoutRepo])

    expect(n).toBe(1)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startSession).mock.calls[0][0]).toMatchObject({
      tid: 'FLO-1',
      repoId: 'repo1',
    })
  })

  it('does not steal selection or close the dialog while batch-launching', async () => {
    const t: Ticket = { tid: 'FLO-3', src: 'linear', title: 'Batch', repo: 'repo1', done: false }
    selectedId.set('preserved')
    dialogOpen.set(true)
    vi.mocked(startSession).mockResolvedValue({
      id: 'started-3',
      tid: 'FLO-3',
      title: 'Batch',
      prompt: 'Begin implementing FLO-3.',
      repoId: 'repo1',
      branch: 'FLO-3-branch',
      status: 'running',
      createdAt: 0,
      src: 'linear',
    })

    await startAgentsFromTickets([t])

    expect(get(selectedId)).toBe('preserved')
    expect(get(dialogOpen)).toBe(true)
  })
})

describe('runApp / stopApp store integration', () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'u1',
      tid: 'A',
      src: 'linear',
      status: 'running',
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
    runningApps.set(new Set())
    vi.clearAllMocks()
  })

  it('runAppForSession adds the session key to runningApps on started', async () => {
    vi.mocked(runApp).mockResolvedValue({ started: true, port: 3000 })
    const session = makeSession()

    await runAppForSession(session)

    expect(get(runningApps).has(appRunKey(session) as string)).toBe(true)
  })

  it('stopAppForSession calls stopApp and removes the session key from runningApps', async () => {
    vi.mocked(runApp).mockResolvedValue({ started: true, port: 3000 })
    vi.mocked(stopApp).mockResolvedValue({ stopped: true })
    const session = makeSession()

    await runAppForSession(session)
    expect(get(runningApps).has(appRunKey(session) as string)).toBe(true)

    await stopAppForSession(session)

    expect(stopApp).toHaveBeenCalledWith({ repoId: 'repo1', branch: 'A-branch' })
    expect(get(runningApps).has(appRunKey(session) as string)).toBe(false)
  })
})

describe('reviewComments store', () => {
  function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
    return {
      id: 'c1',
      file: 'src/foo.ts',
      side: 'new',
      line: 10,
      lineText: 'const x = 1',
      text: 'nit',
      ...overrides,
    }
  }

  beforeEach(() => {
    reviewComments.set({})
  })

  it('addReviewComment appends a comment under the session key', () => {
    addReviewComment('s1', makeComment())
    expect(get(reviewComments)['s1']).toEqual([makeComment()])
  })

  it('addReviewComment keeps separate sessions independent', () => {
    addReviewComment('s1', makeComment({ id: 'c1' }))
    addReviewComment('s2', makeComment({ id: 'c2' }))
    expect(get(reviewComments)['s1']).toHaveLength(1)
    expect(get(reviewComments)['s2']).toHaveLength(1)
    expect(get(reviewComments)['s1']?.[0].id).toBe('c1')
    expect(get(reviewComments)['s2']?.[0].id).toBe('c2')
  })

  it('removeReviewComment drops only the matching comment id for that session', () => {
    addReviewComment('s1', makeComment({ id: 'c1' }))
    addReviewComment('s1', makeComment({ id: 'c2' }))
    removeReviewComment('s1', 'c1')
    const remaining = get(reviewComments)['s1'] ?? []
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('c2')
  })

  it('removeReviewComment on an unknown session id is a no-op', () => {
    removeReviewComment('missing', 'c1')
    expect(get(reviewComments)['missing']).toBeUndefined()
  })

  it('clearReviewComments removes all comments for that session only', () => {
    addReviewComment('s1', makeComment({ id: 'c1' }))
    addReviewComment('s2', makeComment({ id: 'c2' }))
    clearReviewComments('s1')
    expect(get(reviewComments)['s1']).toBeUndefined()
    expect(get(reviewComments)['s2']).toHaveLength(1)
  })
})

describe('refreshAndReconcile merged-branch cleanup', () => {
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
    vi.mocked(listTickets).mockResolvedValue([])
    vi.mocked(killSession).mockResolvedValue(undefined)
  })

  it('cleans up a session whose branch is merged into base', async () => {
    vi.mocked(sessionMerged).mockResolvedValue({ merged: true, via: 'merge-commit' })
    vi.mocked(cleanupSession).mockResolvedValue({ removed: true })

    await refreshAndReconcile()

    expect(sessionMerged).toHaveBeenCalledWith('u1')
    expect(cleanupSession).toHaveBeenCalledWith('u1', { force: false })
    expect(get(sessions).find((s) => s.id === 'u1')).toBeUndefined()
  })

  it('leaves an unmerged session alone', async () => {
    vi.mocked(sessionMerged).mockResolvedValue({ merged: false })

    await refreshAndReconcile()

    expect(cleanupSession).not.toHaveBeenCalled()
    expect(get(sessions).find((s) => s.id === 'u1')).toBeDefined()
  })

  it('a merged-probe failure does not break the refresh or clean anything', async () => {
    vi.mocked(sessionMerged).mockRejectedValue(new Error('offline'))

    await refreshAndReconcile()

    expect(cleanupSession).not.toHaveBeenCalled()
    expect(get(sessions)).toHaveLength(1)
  })

  it('never force-removes: a merged session with a dirty worktree is kept with a warning', async () => {
    vi.mocked(sessionMerged).mockResolvedValue({ merged: true, via: 'squash' })
    vi.mocked(cleanupSession).mockResolvedValue({ removed: false, reason: '2 files changed' })

    await refreshAndReconcile()

    expect(cleanupSession).toHaveBeenCalledTimes(1)
    expect(cleanupSession).toHaveBeenCalledWith('u1', { force: false })
    expect(get(sessions).find((s) => s.id === 'u1')).toBeDefined()
    expect(get(toasts).find((t) => t.type === 'warning')).toBeDefined()
  })
})
