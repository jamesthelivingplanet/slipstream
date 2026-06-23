import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRpc } from './rpc.js'
import type { IpcDeps } from '../ipc.js'
import { IPC } from '../shared/contract.js'
import type {
  RepoDTO,
  SessionDTO,
  WorktreeInfo,
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  ISessionStore,
  SessionStatus,
} from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'

// ── Fake deps ─────────────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<RepoDTO> = {}): RepoDTO {
  return { id: 'r1', org: 'acme', name: 'api', base: 'main', path: '/repos/api', ...overrides }
}

function makeSession(overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 's1',
    tid: 'T-1',
    title: 'Fix bug',
    prompt: 'fix it',
    repoId: 'r1',
    branch: 't-1-fix-bug',
    status: 'running',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeWorktreeInfo(): WorktreeInfo {
  return { branch: 'T-1-fix-bug', path: '/wt/T-1-fix-bug', dirty: false, ahead: 0, behind: 0, added: 0, deleted: 0 }
}

type Listener = (...args: unknown[]) => void

function makeFakeDeps(): IpcDeps & { _emit: (event: string, ...args: unknown[]) => void } {
  const listeners: Record<string, Listener[]> = {}

  const sessions: ISessionManager = {
    start: vi.fn().mockReturnValue(makeSession()),
    resume: vi.fn().mockReturnValue(makeSession()),
    attachRemoteControl: vi.fn().mockReturnValue(makeSession()),
    has: vi.fn().mockReturnValue(false),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    getBuffer: vi.fn().mockReturnValue({ data: 'buffered output', seq: 15 }),
    on(event: string, listener: Listener) {
      listeners[event] ??= []
      listeners[event].push(listener)
    },
    off(event: string, listener: Listener) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== listener)
      }
    },
  } as unknown as ISessionManager

  const repo = makeRepo()

  const repos: IRepoRegistry = {
    list: vi.fn().mockResolvedValue([repo]),
    register: vi.fn().mockResolvedValue(repo),
    get: vi.fn().mockResolvedValue(repo),
    remove: vi.fn().mockResolvedValue(undefined),
  }

  const worktrees: IWorktreeManager = {
    pathFor: vi.fn().mockReturnValue('/wt/t-1-fix-bug'),
    create: vi.fn().mockResolvedValue(makeWorktreeInfo()),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    status: vi.fn().mockResolvedValue(makeWorktreeInfo()),
    list: vi.fn().mockResolvedValue([makeWorktreeInfo()]),
  }

  const ports: IPortBroker = {
    claim: vi.fn().mockResolvedValue(3001),
  }

  const tickets: ITicketProvider = {
    id: 'test',
    listTickets: vi.fn().mockResolvedValue([]),
    getTicketStatus: vi.fn().mockResolvedValue({ current: null, available: [] }),
    setTicketStatus: vi.fn().mockRejectedValue(new Error('not implemented')),
  }

  const config: IConfigStore = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
  }

  const sessionStoreMap = new Map<string, SessionDTO>()
  const sessionStore: ISessionStore = {
    list() { return Array.from(sessionStoreMap.values()) },
    get(id) { return sessionStoreMap.get(id) },
    upsert(s) { sessionStoreMap.set(s.id, s) },
    delete(id) { sessionStoreMap.delete(id) },
  }

  return {
    repos,
    worktrees,
    sessions,
    ports,
    tickets,
    config,
    sessionStore,
    _emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args)
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createRpc', () => {
  let deps: ReturnType<typeof makeFakeDeps>
  let emitted: Array<[string, ...unknown[]]>
  let rpc: ReturnType<typeof createRpc>

  beforeEach(() => {
    deps = makeFakeDeps()
    emitted = []
    rpc = createRpc(deps, (channel, ...args) => {
      emitted.push([channel, ...args])
    })
  })

  it('routes listRepos to repos.list()', async () => {
    const result = await rpc.handle(IPC.listRepos, [])
    expect(deps.repos.list).toHaveBeenCalledOnce()
    expect(result).toEqual([makeRepo()])
  })

  it('routes registerRepo with the correct arg', async () => {
    const result = await rpc.handle(IPC.registerRepo, ['/some/path'])
    expect(deps.repos.register).toHaveBeenCalledWith('/some/path')
    expect(result).toEqual(makeRepo())
  })

  it('routes removeRepo', async () => {
    await rpc.handle(IPC.removeRepo, ['r1'])
    expect(deps.repos.remove).toHaveBeenCalledWith('r1')
  })

  it('routes listTickets', async () => {
    const result = await rpc.handle(IPC.listTickets, [])
    expect(deps.tickets.listTickets).toHaveBeenCalledOnce()
    expect(result).toEqual([])
  })

  it('routes startSession — creates worktree, claims port, starts session', async () => {
    const result = await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ]) as SessionDTO & { port?: number }

    expect(deps.worktrees.create).toHaveBeenCalledWith(makeRepo(), 'T-1-fix-bug')
    expect(deps.ports.claim).toHaveBeenCalled()
    expect(deps.sessions.start).toHaveBeenCalled()
    expect(result.id).toBe('s1')
    expect(result.port).toBe(3001)
  })

  it('routes killSession', async () => {
    await rpc.handle(IPC.killSession, ['s1'])
    expect(deps.sessions.kill).toHaveBeenCalledWith('s1')
  })

  it('routes cleanupSession — returns not found when no meta', async () => {
    const result = await rpc.handle(IPC.cleanupSession, ['s999'])
    expect(result).toEqual({ removed: false, reason: 'session not found' })
  })

  it('routes cleanupSession — removes worktree after startSession', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    const result = await rpc.handle(IPC.cleanupSession, ['s1'])
    expect(deps.worktrees.remove).toHaveBeenCalled()
    expect(result).toEqual({ removed: true })
  })

  it('routes writeSession (fire-and-forget)', async () => {
    await rpc.handle(IPC.writeSession, ['s1', 'hello'])
    expect(deps.sessions.write).toHaveBeenCalledWith('s1', 'hello')
  })

  it('routes resizeSession', async () => {
    await rpc.handle(IPC.resizeSession, ['s1', 80, 24])
    expect(deps.sessions.resize).toHaveBeenCalledWith('s1', 80, 24)
  })

  it('throws for pickRepo (desktop-only)', async () => {
    await expect(rpc.handle(IPC.pickRepo, [])).rejects.toThrow(/desktop window/)
  })

  it('throws for unknown channel', async () => {
    await expect(rpc.handle('unknown:channel', [])).rejects.toThrow(/Unknown channel/)
  })

  it('forwards session data events to emit (3-arg form with seq)', () => {
    deps._emit('data', 's1', 'some output', 42)
    expect(emitted).toEqual([[IPC.sessionData, 's1', 'some output', 42]])
  })

  it('routes getSessionBuffer to sessions.getBuffer', async () => {
    const result = await rpc.handle(IPC.getSessionBuffer, ['s1'])
    expect(deps.sessions.getBuffer).toHaveBeenCalledWith('s1')
    expect(result).toEqual({ data: 'buffered output', seq: 15 })
  })

  it('forwards session status events to emit', () => {
    deps._emit('status', 's1', 'done' satisfies SessionStatus)
    expect(emitted).toEqual([[IPC.sessionStatus, 's1', 'done']])
  })

  it('dispose() removes event listeners', () => {
    rpc.dispose()
    deps._emit('data', 's1', 'after dispose')
    expect(emitted).toHaveLength(0)
  })

  it('dispose() does not throw (regression: sessions.off must exist)', () => {
    expect(() => rpc.dispose()).not.toThrow()
  })

  it('dispose() calls sessions.off for data and status', () => {
    const offSpy = vi.spyOn(deps.sessions, 'off')
    rpc.dispose()
    expect(offSpy).toHaveBeenCalledWith('data', expect.any(Function))
    expect(offSpy).toHaveBeenCalledWith('status', expect.any(Function))
  })

  it('startSession persists session to sessionStore', async () => {
    await rpc.handle(IPC.startSession, [{ tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' }])
    expect(deps.sessionStore.list()).toHaveLength(1)
    expect(deps.sessionStore.list()[0].id).toBe('s1')
  })

  it('listSessions returns persisted rows', async () => {
    await rpc.handle(IPC.startSession, [{ tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' }])
    const result = await rpc.handle(IPC.listSessions, [])
    expect(result).toHaveLength(1)
  })

  it('resumeSession respawns a missing session (not in has())', async () => {
    deps.sessionStore.upsert(makeSession())
    ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)

    const result = await rpc.handle(IPC.resumeSession, ['s1']) as SessionDTO
    expect(deps.sessions.resume).toHaveBeenCalled()
    expect(result.id).toBe('s1')
  })

  it('resumeSession is a no-op when has() is true', async () => {
    deps.sessionStore.upsert(makeSession())
    ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(true)

    await rpc.handle(IPC.resumeSession, ['s1'])
    expect(deps.sessions.resume).not.toHaveBeenCalled()
  })

  it('cleanupSession deletes from sessionStore after worktree removed', async () => {
    await rpc.handle(IPC.startSession, [{ tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' }])
    expect(deps.sessionStore.list()).toHaveLength(1)
    await rpc.handle(IPC.cleanupSession, ['s1'])
    expect(deps.sessionStore.list()).toHaveLength(0)
  })

  it('cleanupSession works post-restart when sessionMeta is cleared', async () => {
    deps.sessionStore.upsert(makeSession({ id: 's1', repoId: 'r1', branch: 't-1-fix-bug' }))
    const result = await rpc.handle(IPC.cleanupSession, ['s1'])
    expect(deps.worktrees.remove).toHaveBeenCalled()
    expect(result).toEqual({ removed: true })
    expect(deps.sessionStore.list()).toHaveLength(0)
  })

  it('attachRemoteControl calls sessions.attachRemoteControl and upserts status running', async () => {
    deps.sessionStore.upsert(makeSession())

    const result = await rpc.handle(IPC.attachRemoteControl, ['s1']) as SessionDTO & { port?: number }
    expect(deps.sessions.attachRemoteControl).toHaveBeenCalled()
    expect(result.id).toBe('s1')
    expect(deps.sessionStore.get('s1')?.status).toBe('running')
  })

  it('attachRemoteControl throws when session is not in store', async () => {
    await expect(rpc.handle(IPC.attachRemoteControl, ['missing'])).rejects.toThrow('Session not found: missing')
  })

  it('startSession passes systemPrompt containing the ticket id to sessions.start', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    expect(deps.sessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining('T-1') })
    )
  })
})
