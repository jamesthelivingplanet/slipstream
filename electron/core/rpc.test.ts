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
  WriteLockState,
} from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'
import type { IEditorLauncher } from '../services/editorLauncher.js'
import type { IPushService } from '../services/pushService.js'
import { createWriteCoordinator } from '../services/writeCoordinator.js'
import type { IWriteCoordinator } from '../services/writeCoordinator.js'

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
    agentKind: 'claude-code',
    ...overrides,
  }
}

function makeWorktreeInfo(): WorktreeInfo {
  return {
    branch: 'T-1-fix-bug',
    path: '/wt/T-1-fix-bug',
    dirty: false,
    ahead: 0,
    behind: 0,
    added: 0,
    deleted: 0,
  }
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
    setOpencodeSid: vi.fn(),
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
    registerByUrl: vi.fn().mockResolvedValue(repo),
    get: vi.fn().mockResolvedValue(repo),
    resolvePath: vi.fn().mockResolvedValue(repo),
    remove: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ installCmd: '', startCmd: '' }),
    setSettings: vi.fn().mockResolvedValue(undefined),
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
    startTicket: vi.fn().mockResolvedValue(null),
    resetTicket: vi.fn().mockResolvedValue(null),
  }

  const config: IConfigStore = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
  }

  const sessionStoreMap = new Map<string, SessionDTO>()
  const sessionStore: ISessionStore = {
    list() {
      return Array.from(sessionStoreMap.values())
    },
    get(id) {
      return sessionStoreMap.get(id)
    },
    upsert(s) {
      sessionStoreMap.set(s.id, s)
    },
    delete(id) {
      sessionStoreMap.delete(id)
    },
  }

  const editor = { open: vi.fn().mockResolvedValue(undefined) } as unknown as IEditorLauncher
  const appRunner = {
    run: vi.fn().mockResolvedValue({ pid: 1234 }),
  }

  const push: IPushService = {
    getVapidPublicKey: vi.fn().mockResolvedValue('test-vapid-key'),
    savePushSubscription: vi.fn().mockResolvedValue(undefined),
    deletePushSubscription: vi.fn().mockResolvedValue(undefined),
    getPushPrefs: vi.fn().mockResolvedValue(null),
  }

  return {
    repos,
    worktrees,
    sessions,
    ports,
    tickets,
    config,
    sessionStore,
    editor,
    appRunner,
    push,
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
    rpc = createRpc(
      deps,
      (channel, ...args) => {
        emitted.push([channel, ...args])
      },
      { coalesceMs: 0 },
    )
  })

  it('routes listRepos to repos.list()', async () => {
    const result = await rpc.handle(IPC.listRepos, [])
    expect(deps.repos.list).toHaveBeenCalledOnce()
    expect(result).toEqual([makeRepo()])
  })

  it('routes registerRepo with the correct arg', async () => {
    const result = await rpc.handle(IPC.registerRepo, ['/some/path'])
    expect(deps.repos.register).toHaveBeenCalledWith('/some/path', 'local')
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
    const result = (await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])) as SessionDTO & { port?: number }

    expect(deps.worktrees.create).toHaveBeenCalledWith(makeRepo(), 'T-1-fix-bug')
    expect(deps.ports.claim).toHaveBeenCalled()
    expect(deps.sessions.start).toHaveBeenCalled()
    expect(result.id).toBe('s1')
    expect(result.port).toBe(3001)
  })
  it('startSession passes agentKind to sessions.start', async () => {
    ;(await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1', agentKind: 'opencode' },
    ])) as SessionDTO & { port?: number }

    expect(deps.sessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'opencode' }),
    )
  })

  it('startSession defaults agentKind to undefined when not provided', async () => {
    ;(await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])) as SessionDTO & { port?: number }

    const callArgs = (deps.sessions.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.agentKind).toBeUndefined()
  })

  it('startSession stores agentKind in sessionStore', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1', agentKind: 'opencode' },
    ])
    const stored = deps.sessionStore.get('s1')
    expect(stored?.agentKind).toBe('opencode')
  })

  it('routes killSession', async () => {
    deps.sessionStore.upsert(makeSession())
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
    deps.sessionStore.upsert(makeSession())
    await rpc.handle(IPC.writeSession, ['s1', 'hello'])
    expect(deps.sessions.write).toHaveBeenCalledWith('s1', 'hello')
  })

  it('routes resizeSession', async () => {
    deps.sessionStore.upsert(makeSession())
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

  it('coalesces session:data bursts into a single timed flush', () => {
    vi.useFakeTimers()
    const out: Array<[string, ...unknown[]]> = []
    const rpc2 = createRpc(deps, (channel, ...args) => out.push([channel, ...args]), {
      coalesceMs: 40,
    })
    deps._emit('data', 's1', 'a', 1)
    deps._emit('data', 's1', 'b', 2)
    deps._emit('data', 's1', 'c', 3)
    expect(out).toEqual([])
    vi.advanceTimersByTime(40)
    expect(out).toEqual([[IPC.sessionData, 's1', 'abc', 3]])
    rpc2.dispose()
    vi.useRealTimers()
  })

  it('routes getSessionBuffer to sessions.getBuffer', async () => {
    deps.sessionStore.upsert(makeSession())
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
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    expect(deps.sessionStore.list()).toHaveLength(1)
    expect(deps.sessionStore.list()[0].id).toBe('s1')
  })

  it('listSessions returns persisted rows', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    const result = await rpc.handle(IPC.listSessions, [])
    expect(result).toHaveLength(1)
  })

  it('resumeSession respawns a missing session (not in has())', async () => {
    deps.sessionStore.upsert(makeSession())
    ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)

    const result = (await rpc.handle(IPC.resumeSession, ['s1'])) as SessionDTO
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
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
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

    const result = (await rpc.handle(IPC.attachRemoteControl, ['s1'])) as SessionDTO & {
      port?: number
    }
    expect(deps.sessions.attachRemoteControl).toHaveBeenCalled()
    expect(result.id).toBe('s1')
    expect(deps.sessionStore.get('s1')?.status).toBe('running')
  })

  it('attachRemoteControl throws when session is not in store', async () => {
    await expect(rpc.handle(IPC.attachRemoteControl, ['missing'])).rejects.toThrow(
      'Session not found: missing',
    )
  })

  it('routes worktreeStatus to worktrees.status with resolved repo and branch', async () => {
    const result = await rpc.handle(IPC.worktreeStatus, ['r1', 't-1-fix-bug'])
    expect(deps.repos.get).toHaveBeenCalledWith('r1')
    expect(deps.worktrees.status).toHaveBeenCalledWith(makeRepo(), 't-1-fix-bug')
    expect(result).toEqual(makeWorktreeInfo())
  })

  it('worktreeStatus throws for unknown repo', async () => {
    ;(deps.repos as unknown as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValueOnce(
      undefined,
    )
    await expect(rpc.handle(IPC.worktreeStatus, ['unknown', 'branch'])).rejects.toThrow(
      'Unknown repo: unknown',
    )
  })

  it('startSession passes systemPrompt containing the ticket id to sessions.start', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    expect(deps.sessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining('T-1') }),
    )
  })

  it('startSession transitions the linked ticket to in-progress (startTicket)', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    expect(deps.tickets.startTicket).toHaveBeenCalledWith('T-1')
  })

  it('startSession still succeeds when startTicket rejects', async () => {
    ;(deps.tickets.startTicket as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('linear down'),
    )
    const result = (await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])) as SessionDTO
    expect(result.id).toBe('s1')
  })

  it('startSession calls repos.resolvePath (not get) before creating the worktree', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    expect(deps.repos.resolvePath).toHaveBeenCalledWith('r1')
    expect(deps.worktrees.create).toHaveBeenCalledWith(makeRepo(), 'T-1-fix-bug')
  })

  it('startSession surfaces resolvePath errors (clear failure, not silent)', async () => {
    ;(
      deps.repos as unknown as { resolvePath: ReturnType<typeof vi.fn> }
    ).resolvePath.mockRejectedValueOnce(
      new Error(
        'Repository path no longer exists: /gone/repo. Re-register it or restore the directory.',
      ),
    )
    await expect(
      rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
      ]),
    ).rejects.toThrow(/Repository path no longer exists/)
    expect(deps.worktrees.create).not.toHaveBeenCalled()
  })

  it('startSession uses the resolved (healed) repo path for worktree creation', async () => {
    const healed = makeRepo({ path: '/new-location/api' })
    ;(
      deps.repos as unknown as { resolvePath: ReturnType<typeof vi.fn> }
    ).resolvePath.mockResolvedValueOnce(healed)
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    expect(deps.worktrees.create).toHaveBeenCalledWith(healed, 'T-1-fix-bug')
  })

  it('resumeSession calls resolvePath and throws clearly when repo is gone', async () => {
    deps.sessionStore.upsert(makeSession())
    ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)
    ;(
      deps.repos as unknown as { resolvePath: ReturnType<typeof vi.fn> }
    ).resolvePath.mockRejectedValueOnce(
      new Error(
        'Repository path no longer exists: /gone. Re-register it or restore the directory.',
      ),
    )
    await expect(rpc.handle(IPC.resumeSession, ['s1'])).rejects.toThrow(
      /Repository path no longer exists/,
    )
  })

  it('cleanupSession resets the linked ticket back to to-do (resetTicket)', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    await rpc.handle(IPC.cleanupSession, ['s1'])
    expect(deps.tickets.resetTicket).toHaveBeenCalledWith('T-1')
  })

  it('cleanupSession still succeeds when resetTicket rejects', async () => {
    ;(deps.tickets.resetTicket as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('linear down'),
    )
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    const result = await rpc.handle(IPC.cleanupSession, ['s1'])
    expect(result).toEqual({ removed: true })
  })

  describe('editor config', () => {
    it('getEditorConfig returns defaults when config.get returns undefined', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
      const result = (await rpc.handle(IPC.getEditorConfig, [])) as {
        command: string
        mobileCommand: string
      }
      expect(result).toEqual({ command: 'code', mobileCommand: '' })
    })

    it('setEditorConfig calls config.set for both keys', async () => {
      await rpc.handle(IPC.setEditorConfig, [{ command: 'zed', mobileCommand: 'vim' }])
      expect(deps.config.set).toHaveBeenCalledWith('editor.command', 'zed')
      expect(deps.config.set).toHaveBeenCalledWith('editor.mobileCommand', 'vim')
    })

    it('openInEditor uses desktop command by default', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'editor.command') return 'code'
        if (key === 'editor.mobileCommand') return ''
        return undefined
      })
      await rpc.handle(IPC.openInEditor, [{ repoId: 'r1', branch: 't-1-fix-bug' }])
      expect(deps.editor.open).toHaveBeenCalledWith('code', '/wt/t-1-fix-bug')
    })

    it('openInEditor uses mobile command when mobile=true and mobileCommand is set', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'editor.command') return 'code'
        if (key === 'editor.mobileCommand') return 'vim'
        return undefined
      })
      await rpc.handle(IPC.openInEditor, [{ repoId: 'r1', branch: 't-1-fix-bug', mobile: true }])
      expect(deps.editor.open).toHaveBeenCalledWith('vim', '/wt/t-1-fix-bug')
    })

    it('openInEditor throws for unknown repo', async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
      await expect(rpc.handle(IPC.openInEditor, [{ repoId: 'bad', branch: 'b' }])).rejects.toThrow(
        'Unknown repo: bad',
      )
    })
  })

  it('getRepoSettings routes to repos.getSettings', async () => {
    const result = await rpc.handle(IPC.getRepoSettings, ['r1'])
    expect(deps.repos.getSettings).toHaveBeenCalledWith('r1')
    expect(result).toEqual({ installCmd: '', startCmd: '' })
  })

  it('setRepoSettings routes to repos.setSettings with id and settings', async () => {
    const settings = { installCmd: 'pnpm install', startCmd: 'pnpm dev' }
    await rpc.handle(IPC.setRepoSettings, ['r1', settings])
    expect(deps.repos.setSettings).toHaveBeenCalledWith('r1', settings)
  })

  it('runApp returns { started: false, reason: "no-start-command" } when startCmd is empty', async () => {
    const result = await rpc.handle(IPC.runApp, [{ repoId: 'r1', branch: 'main' }])
    expect(result).toEqual({ started: false, reason: 'no-start-command' })
    expect(deps.appRunner.run).not.toHaveBeenCalled()
  })

  it('runApp with a startCmd calls appRunner.run and returns { started: true, port }', async () => {
    ;(deps.repos.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      installCmd: '',
      startCmd: 'pnpm dev',
    })
    const result = (await rpc.handle(IPC.runApp, [{ repoId: 'r1', branch: 'main' }])) as {
      started: boolean
      port?: number
    }
    expect(deps.appRunner.run).toHaveBeenCalledWith('/wt/t-1-fix-bug', 'pnpm dev', { PORT: '3001' })
    expect(result).toEqual({ started: true, port: 3001 })
  })

  describe('owner filter (identity seam)', () => {
    it('startSession stamps the caller identity as ownerId', async () => {
      await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
      ])
      expect(deps.sessionStore.get('s1')?.ownerId).toBe('local')
    })

    it('listSessions returns rows owned by the caller (default local sees local rows)', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'mine', ownerId: 'local' }))
      deps.sessionStore.upsert(makeSession({ id: 'legacy' })) // no ownerId → treated as local
      const result = (await rpc.handle(IPC.listSessions, [])) as SessionDTO[]
      expect(result.map((s) => s.id).sort()).toEqual(['legacy', 'mine'])
    })

    it('listSessions excludes rows owned by a different identity', async () => {
      const aliceRpc = createRpc(deps, () => {}, { coalesceMs: 0, identity: { id: 'alice' } })
      deps.sessionStore.upsert(makeSession({ id: 'mine', ownerId: 'local' }))
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      const result = (await aliceRpc.handle(IPC.listSessions, [])) as SessionDTO[]
      expect(result.map((s) => s.id)).toEqual(['hers'])
      aliceRpc.dispose()
    })

    it('listRepos filters by caller identity', async () => {
      ;(deps.repos.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeRepo({ id: 'mine', ownerId: 'local' }),
        makeRepo({ id: 'hers', ownerId: 'alice' }),
        makeRepo({ id: 'legacy' }), // no ownerId → local
      ])
      const result = (await rpc.handle(IPC.listRepos, [])) as RepoDTO[]
      expect(result.map((r) => r.id).sort()).toEqual(['legacy', 'mine'])
    })
  })

  describe('ownership guards (identity seam)', () => {
    it('registerRepo stamps the caller identity', async () => {
      await rpc.handle(IPC.registerRepo, ['/some/path'])
      expect(deps.repos.register).toHaveBeenCalledWith('/some/path', 'local')
    })

    it('resumeSession throws not-found for a session owned by another identity', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)
      await expect(rpc.handle(IPC.resumeSession, ['s1'])).rejects.toThrow('Session not found: s1')
      expect(deps.sessions.resume).not.toHaveBeenCalled()
    })

    it('resumeSession does not return a hot session owned by another identity', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(true)
      await expect(rpc.handle(IPC.resumeSession, ['s1'])).rejects.toThrow('Session not found: s1')
    })

    it("attachRemoteControl throws not-found for another identity's session", async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.attachRemoteControl, ['s1'])).rejects.toThrow(
        'Session not found: s1',
      )
    })

    it("cleanupSession reports not-found for another identity's session", async () => {
      deps.sessionStore.upsert(
        makeSession({ id: 's1', ownerId: 'alice', repoId: 'r1', branch: 't-1-fix-bug' }),
      )
      const result = await rpc.handle(IPC.cleanupSession, ['s1'])
      expect(result).toEqual({ removed: false, reason: 'session not found' })
      expect(deps.worktrees.remove).not.toHaveBeenCalled()
    })

    it("getSessionBuffer throws not-found for another identity's session", async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.getSessionBuffer, ['s1'])).rejects.toThrow(
        'Session not found: s1',
      )
    })

    it("worktreeStatus throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.worktreeStatus, ['r1', 'b'])).rejects.toThrow('Unknown repo: r1')
    })

    it("openInEditor throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.openInEditor, [{ repoId: 'r1', branch: 'b' }])).rejects.toThrow(
        'Unknown repo: r1',
      )
    })

    it("runApp throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.runApp, [{ repoId: 'r1', branch: 'b' }])).rejects.toThrow(
        'Unknown repo: r1',
      )
    })

    it("getRepoSettings throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.getRepoSettings, ['r1'])).rejects.toThrow('Unknown repo: r1')
    })

    it("setRepoSettings throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(
        rpc.handle(IPC.setRepoSettings, ['r1', { installCmd: '', startCmd: '' }]),
      ).rejects.toThrow('Unknown repo: r1')
      expect(deps.repos.setSettings).not.toHaveBeenCalled()
    })

    it('startSession throws Unknown repo when the repo is owned by another identity', async () => {
      ;(deps.repos.resolvePath as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(
        rpc.handle(IPC.startSession, [
          { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
        ]),
      ).rejects.toThrow('Unknown repo: r1')
      expect(deps.worktrees.create).not.toHaveBeenCalled()
    })

    it("killSession no-ops for another identity's session", async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await rpc.handle(IPC.killSession, ['s1'])
      expect(deps.sessions.kill).not.toHaveBeenCalled()
    })

    it("writeSession no-ops for another identity's session", async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await rpc.handle(IPC.writeSession, ['s1', 'hello'])
      expect(deps.sessions.write).not.toHaveBeenCalled()
    })

    it("resizeSession no-ops for another identity's session", async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await rpc.handle(IPC.resizeSession, ['s1', 80, 24])
      expect(deps.sessions.resize).not.toHaveBeenCalled()
    })

    it("detachSession no-ops for another identity's session", async () => {
      const coord = createWriteCoordinator()
      deps.writeCoordinator = coord
      const guardedRpc = createRpc(deps, () => {}, { coalesceMs: 0 })
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      const detachSpy = vi.spyOn(coord, 'detach')
      await expect(guardedRpc.handle(IPC.detachSession, ['s1'])).resolves.toBeUndefined()
      expect(detachSpy).not.toHaveBeenCalled()
      guardedRpc.dispose()
    })

    it("attachSession does not attach another identity's session", async () => {
      const coord = createWriteCoordinator()
      deps.writeCoordinator = coord
      const guardedRpc = createRpc(deps, () => {}, { coalesceMs: 0, clientId: 'client-x' })
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await guardedRpc.handle(IPC.attachSession, ['s1'])
      expect(coord.isViewer('s1', 'client-x')).toBe(false)
      guardedRpc.dispose()
    })

    it("takeWrite does not grant the lock for another identity's session", async () => {
      const coord = createWriteCoordinator()
      deps.writeCoordinator = coord
      const guardedRpc = createRpc(deps, () => {}, { coalesceMs: 0, clientId: 'client-x' })
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await guardedRpc.handle(IPC.takeWrite, ['s1'])
      expect(coord.canWrite('s1', 'client-x')).toBe(false)
      guardedRpc.dispose()
    })

    it("removeRepo throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.removeRepo, ['r1'])).rejects.toThrow('Unknown repo: r1')
      expect(deps.repos.remove).not.toHaveBeenCalled()
    })
  })

  describe('multi-client write lock', () => {
    let sharedDeps: ReturnType<typeof makeFakeDeps>
    let coord: IWriteCoordinator
    let emittedA: Array<[string, ...unknown[]]>
    let emittedB: Array<[string, ...unknown[]]>
    let rpcA: ReturnType<typeof createRpc>
    let rpcB: ReturnType<typeof createRpc>

    beforeEach(() => {
      sharedDeps = makeFakeDeps()
      coord = createWriteCoordinator()
      sharedDeps.writeCoordinator = coord
      sharedDeps.sessionStore.upsert(makeSession({ id: 's1' }))
      emittedA = []
      emittedB = []
      rpcA = createRpc(
        sharedDeps,
        (channel, ...args) => {
          emittedA.push([channel, ...args])
        },
        { coalesceMs: 0, clientId: 'client-a' },
      )
      rpcB = createRpc(
        sharedDeps,
        (channel, ...args) => {
          emittedB.push([channel, ...args])
        },
        { coalesceMs: 0, clientId: 'client-b' },
      )
    })

    it('grants the write lock to the first client to attach, view-only for the second', async () => {
      const lockA = (await rpcA.handle(IPC.attachSession, ['s1'])) as WriteLockState
      const lockB = (await rpcB.handle(IPC.attachSession, ['s1'])) as WriteLockState

      expect(lockA.canWrite).toBe(true)
      expect(lockB.canWrite).toBe(false)
      expect(lockB.viewers).toBe(2)
    })

    it('blocks writeSession from a view-only client but allows the holder', async () => {
      await rpcA.handle(IPC.attachSession, ['s1'])
      await rpcB.handle(IPC.attachSession, ['s1'])

      await rpcB.handle(IPC.writeSession, ['s1', 'hello'])
      expect(sharedDeps.sessions.write).not.toHaveBeenCalled()

      await rpcA.handle(IPC.writeSession, ['s1', 'hello'])
      expect(sharedDeps.sessions.write).toHaveBeenCalledWith('s1', 'hello')
    })

    it('takeWrite flips the lock and pushes session:writeLock to both attached clients', async () => {
      await rpcA.handle(IPC.attachSession, ['s1'])
      await rpcB.handle(IPC.attachSession, ['s1'])
      emittedA.length = 0
      emittedB.length = 0

      const lockB = (await rpcB.handle(IPC.takeWrite, ['s1'])) as WriteLockState
      expect(lockB.canWrite).toBe(true)

      const pushA = emittedA.find(([ch]) => ch === IPC.sessionWriteLock)
      const pushB = emittedB.find(([ch]) => ch === IPC.sessionWriteLock)
      expect(pushA).toBeTruthy()
      expect(pushB).toBeTruthy()
      expect((pushA![1] as WriteLockState).canWrite).toBe(false)
      expect((pushB![1] as WriteLockState).canWrite).toBe(true)
    })

    it('resizeSession is blocked for a view-only client', async () => {
      await rpcA.handle(IPC.attachSession, ['s1'])
      await rpcB.handle(IPC.attachSession, ['s1'])

      await rpcB.handle(IPC.resizeSession, ['s1', 80, 24])
      expect(sharedDeps.sessions.resize).not.toHaveBeenCalled()

      await rpcA.handle(IPC.resizeSession, ['s1', 80, 24])
      expect(sharedDeps.sessions.resize).toHaveBeenCalledWith('s1', 80, 24)
    })

    it('detachSession on dispose frees the lock for remaining viewers', async () => {
      await rpcA.handle(IPC.attachSession, ['s1'])
      await rpcB.handle(IPC.attachSession, ['s1'])

      rpcA.dispose()

      expect(coord.canWrite('s1', 'client-b')).toBe(true)
    })
  })
})
