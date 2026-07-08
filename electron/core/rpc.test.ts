import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRpc } from './rpc.js'
import type { IpcDeps } from '../ipc.js'
import { IPC } from '../shared/contract.js'
import type {
  RepoDTO,
  SessionDTO,
  SessionOutcomeDTO,
  WorktreeInfo,
  WorktreeDiffDTO,
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  ISessionStore,
  IPromptTemplateStore,
  PromptTemplateDTO,
  IOutcomeStore,
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

function makeWorktreeDiff(): WorktreeDiffDTO {
  return {
    branch: 'T-1-fix-bug',
    base: 'main',
    mergeBase: 'abc123',
    files: [],
    truncated: false,
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
    diff: vi.fn().mockResolvedValue(makeWorktreeDiff()),
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
    postComment: vi.fn().mockResolvedValue(false),
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

  const promptTemplateMap = new Map<string, PromptTemplateDTO>()
  const promptTemplates: IPromptTemplateStore = {
    list(repoId) {
      return Array.from(promptTemplateMap.values()).filter((t) => t.repoId === repoId)
    },
    get(id) {
      return promptTemplateMap.get(id)
    },
    upsert(t) {
      promptTemplateMap.set(t.id, t)
    },
    delete(id) {
      promptTemplateMap.delete(id)
    },
  }

  const editor = { open: vi.fn().mockResolvedValue(undefined) } as unknown as IEditorLauncher
  const appRunner = {
    run: vi.fn().mockResolvedValue({ pid: 1234, reused: false }),
    stop: vi.fn().mockResolvedValue(true),
    isRunning: vi.fn().mockReturnValue(false),
  }

  const tailscale = {
    expose: vi.fn().mockResolvedValue(null),
    unexpose: vi.fn().mockResolvedValue(undefined),
    urlFor: vi.fn().mockReturnValue(null),
  }

  const push: IPushService = {
    getVapidPublicKey: vi.fn().mockResolvedValue('test-vapid-key'),
    savePushSubscription: vi.fn().mockResolvedValue(undefined),
    deletePushSubscription: vi.fn().mockResolvedValue(undefined),
    getPushPrefs: vi.fn().mockResolvedValue(null),
  }

  const outcomeMap = new Map<string, SessionOutcomeDTO>()
  const outcomeStore: IOutcomeStore = {
    get(id) {
      return outcomeMap.get(id)
    },
    upsert(o) {
      outcomeMap.set(o.sessionId, o)
    },
    list() {
      return Array.from(outcomeMap.values())
    },
    delete(id) {
      outcomeMap.delete(id)
    },
  }

  return {
    repos,
    worktrees,
    sessions,
    ports,
    tickets,
    config,
    sessionStore,
    promptTemplates,
    outcomeStore,
    editor,
    appRunner,
    tailscale,
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

  describe('usage (token/cost from transcripts)', () => {
    // The usage handlers read transcripts from claudeProjectsDir(), which honors
    // CLAUDE_CONFIG_DIR. Point it at a temp dir and write fixture transcripts.
    let configDir: string
    let prevConfigDir: string | undefined

    function writeTurn(
      id: string,
      opts: { model?: string; input?: number; output?: number } = {},
    ): void {
      const sub = path.join(configDir, 'projects', 'proj-a')
      fs.mkdirSync(sub, { recursive: true })
      const model = opts.model ?? 'claude-sonnet-5'
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          model,
          usage: {
            input_tokens: opts.input ?? 0,
            output_tokens: opts.output ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
      const file = path.join(sub, `${id}.jsonl`)
      fs.appendFileSync(file, (fs.existsSync(file) ? '\n' : '') + line)
    }

    beforeEach(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-rpc-usage-'))
      prevConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = configDir
    })

    afterEach(() => {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      fs.rmSync(configDir, { recursive: true, force: true })
    })

    it('sessionUsage parses the session transcript (owner-scoped)', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', repoId: 'r1' }))
      writeTurn('s1', { model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000 })
      const result = (await rpc.handle(IPC.sessionUsage, ['s1'])) as {
        exists: boolean
        costUsd: number
        turns: number
        model?: string
      }
      expect(result.exists).toBe(true)
      expect(result.turns).toBe(1)
      expect(result.model).toBe('claude-sonnet-5')
      expect(result.costUsd).toBeCloseTo(18, 4) // sonnet: $3/M in + $15/M out
    })

    it('sessionUsage reports exists:false when no transcript exists yet', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'pre-turn', repoId: 'r1' }))
      const result = (await rpc.handle(IPC.sessionUsage, ['pre-turn'])) as {
        exists: boolean
        costUsd: number
      }
      expect(result.exists).toBe(false)
      expect(result.costUsd).toBe(0)
    })

    it('sessionUsage rejects for a session the caller does not own', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.sessionUsage, ['hers'])).rejects.toThrow(/Session not found/)
    })

    it('usageSummary rolls up across the caller sessions by repo and day', async () => {
      deps.sessionStore.upsert(
        makeSession({ id: 's1', repoId: 'r1', createdAt: Date.UTC(2026, 6, 1) }),
      )
      deps.sessionStore.upsert(
        makeSession({ id: 's2', repoId: 'r2', createdAt: Date.UTC(2026, 6, 2) }),
      )
      // foreign-owner session must be excluded from the summary
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      writeTurn('s1', { model: 'sonnet', input: 1_000_000, output: 1_000_000 }) // $18
      writeTurn('s2', { model: 'opus', input: 1_000_000, output: 1_000_000 }) // $90
      writeTurn('hers', { model: 'sonnet', input: 1_000_000, output: 1_000_000 })

      const result = (await rpc.handle(IPC.usageSummary, [])) as {
        costUsd: number
        byRepo: { key: string; costUsd: number }[]
        byDay: { key: string; costUsd: number }[]
        sessions: { sessionId: string }[]
      }
      expect(result.costUsd).toBeCloseTo(108, 4)
      expect(result.byRepo.map((b) => b.key)).toEqual(['r2', 'r1'])
      expect(result.byDay.map((b) => b.key)).toEqual(['2026-07-02', '2026-07-01'])
      expect(result.sessions).toHaveLength(2)
    })
  })

  describe('session outcome + history (FLO-97)', () => {
    function makeOutcome(overrides: Partial<SessionOutcomeDTO> = {}): SessionOutcomeDTO {
      return {
        sessionId: 's1',
        result: 'success',
        summary: 'Fixed the bug',
        reportedAt: 1000,
        ...overrides,
      }
    }

    it('getSessionOutcome returns the stored outcome', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      deps.outcomeStore.upsert(makeOutcome())

      const result = await rpc.handle(IPC.getSessionOutcome, ['s1'])
      expect(result).toEqual(makeOutcome())
    })

    it('getSessionOutcome returns null when none reported yet', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      const result = await rpc.handle(IPC.getSessionOutcome, ['s1'])
      expect(result).toBeNull()
    })

    it('getSessionOutcome rejects for a session the caller does not own', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.getSessionOutcome, ['hers'])).rejects.toThrow(/Session not found/)
    })

    describe('disk fallback (daemon-restart race)', () => {
      let dataDir: string

      beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-outcome-'))
        deps.appMcp = {
          configDir: dataDir,
          appMcpJsPath: '/app/app-mcp.js',
          electronPath: '/usr/bin/electron',
          dataDir,
        }
      })

      afterEach(() => {
        fs.rmSync(dataDir, { recursive: true, force: true })
      })

      function writeSentinel(sessionId: string, body: Record<string, unknown>): void {
        const dir = path.join(dataDir, 'sessions', sessionId)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'outcome.json'), JSON.stringify(body))
      }

      it('falls back to reading outcome.json off disk when the store misses', async () => {
        deps.sessionStore.upsert(makeSession({ id: 's1' }))
        writeSentinel('s1', { result: 'partial', summary: 'From disk', ts: 555 })

        const result = await rpc.handle(IPC.getSessionOutcome, ['s1'])
        expect(result).toEqual({
          sessionId: 's1',
          result: 'partial',
          summary: 'From disk',
          reportedAt: 555,
        })
      })

      it('backfills the store after a successful disk fallback read', async () => {
        deps.sessionStore.upsert(makeSession({ id: 's1' }))
        writeSentinel('s1', { result: 'success', summary: 'Backfilled', ts: 555 })

        await rpc.handle(IPC.getSessionOutcome, ['s1'])
        expect(deps.outcomeStore.get('s1')?.summary).toBe('Backfilled')
      })

      it('returns null when neither the store nor disk has a valid outcome', async () => {
        deps.sessionStore.upsert(makeSession({ id: 's1' }))
        const result = await rpc.handle(IPC.getSessionOutcome, ['s1'])
        expect(result).toBeNull()
      })

      it('returns null when the on-disk sentinel is malformed', async () => {
        deps.sessionStore.upsert(makeSession({ id: 's1' }))
        writeSentinel('s1', { result: 'bogus', summary: 'x', ts: 1 })
        const result = await rpc.handle(IPC.getSessionOutcome, ['s1'])
        expect(result).toBeNull()
      })
    })

    it('listSessionHistory joins sessions with outcomes and usage, most recent first', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', repoId: 'r1', createdAt: 1000 }))
      deps.sessionStore.upsert(makeSession({ id: 's2', repoId: 'r1', createdAt: 2000 }))
      deps.outcomeStore.upsert(makeOutcome({ sessionId: 's1' }))

      const result = (await rpc.handle(IPC.listSessionHistory, [])) as Array<{
        session: SessionDTO
        outcome: SessionOutcomeDTO | null
        usage: unknown
      }>

      expect(result).toHaveLength(2)
      expect(result[0].session.id).toBe('s2') // most recent first
      expect(result[0].outcome).toBeNull()
      expect(result[1].session.id).toBe('s1')
      expect(result[1].outcome).toEqual(makeOutcome({ sessionId: 's1' }))
    })

    it('listSessionHistory excludes sessions owned by another identity', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))

      const result = (await rpc.handle(IPC.listSessionHistory, [])) as Array<{
        session: SessionDTO
      }>
      expect(result.map((e) => e.session.id)).toEqual(['s1'])
    })

    it('listSessionHistory reports usage:null when no transcript/turns exist', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      const result = (await rpc.handle(IPC.listSessionHistory, [])) as Array<{
        usage: unknown
      }>
      expect(result[0].usage).toBeNull()
    })
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

  it('routes worktreeDiff to worktrees.diff with resolved repo and branch', async () => {
    const result = await rpc.handle(IPC.worktreeDiff, ['r1', 't-1-fix-bug'])
    expect(deps.repos.get).toHaveBeenCalledWith('r1')
    expect(deps.worktrees.diff).toHaveBeenCalledWith(makeRepo(), 't-1-fix-bug')
    expect(result).toEqual(makeWorktreeDiff())
  })

  it('worktreeDiff throws for unknown repo', async () => {
    ;(deps.repos as unknown as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValueOnce(
      undefined,
    )
    await expect(rpc.handle(IPC.worktreeDiff, ['unknown', 'branch'])).rejects.toThrow(
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
    expect(deps.tickets.startTicket).toHaveBeenCalledWith('T-1', undefined)
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
    expect(deps.tickets.resetTicket).toHaveBeenCalledWith('T-1', undefined)
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

  describe('app MCP config lifecycle', () => {
    let configDir: string

    beforeEach(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-mcp-'))
      deps.appMcp = {
        configDir,
        appMcpJsPath: '/app/app-mcp.js',
        electronPath: '/usr/bin/electron',
        dataDir: '/data',
      }
    })

    afterEach(() => {
      fs.rmSync(configDir, { recursive: true, force: true })
    })

    it('resumeSession rewrites the config file and passes mcpConfigPath to sessions.resume', async () => {
      deps.sessionStore.upsert(makeSession())
      ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)

      await rpc.handle(IPC.resumeSession, ['s1'])

      const expected = path.join(configDir, 's1.json')
      expect(deps.sessions.resume).toHaveBeenCalledWith(
        expect.objectContaining({ mcpConfigPath: expected }),
      )
      expect(fs.existsSync(expected)).toBe(true)
    })

    it('attachRemoteControl rewrites the config file and passes mcpConfigPath', async () => {
      deps.sessionStore.upsert(makeSession())

      await rpc.handle(IPC.attachRemoteControl, ['s1'])

      const expected = path.join(configDir, 's1.json')
      expect(deps.sessions.attachRemoteControl).toHaveBeenCalledWith(
        expect.objectContaining({ mcpConfigPath: expected }),
      )
      expect(fs.existsSync(expected)).toBe(true)
    })

    it('cleanupSession deletes the per-session config file when removal succeeds', async () => {
      await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1', sessionId: 's1' },
      ])
      const configPath = path.join(configDir, 's1.json')
      expect(fs.existsSync(configPath)).toBe(true)

      await rpc.handle(IPC.cleanupSession, ['s1'])
      expect(fs.existsSync(configPath)).toBe(false)
    })

    it('cleanupSession keeps the config file when removal fails', async () => {
      await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1', sessionId: 's1' },
      ])
      const configPath = path.join(configDir, 's1.json')
      ;(deps.worktrees.remove as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        removed: false,
        reason: 'dirty',
      })

      await rpc.handle(IPC.cleanupSession, ['s1'])
      expect(fs.existsSync(configPath)).toBe(true)
    })
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
      pid?: number
      reused?: boolean
    }
    expect(deps.appRunner.run).toHaveBeenCalledWith('r1 main', '/wt/t-1-fix-bug', 'pnpm dev', {
      PORT: '3001',
    })
    expect(result).toEqual({ started: true, port: 3001, pid: 1234, reused: false })
  })

  it('runApp exposes the port over tailscale and returns the tailnet URL', async () => {
    ;(deps.repos.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      installCmd: '',
      startCmd: 'pnpm dev',
    })
    ;(deps.tailscale!.expose as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      'https://devbox.tail1234.ts.net:3001',
    )
    const result = await rpc.handle(IPC.runApp, [{ repoId: 'r1', branch: 'main' }])
    expect(deps.tailscale!.expose).toHaveBeenCalledWith('r1 main', 3001)
    expect(result).toEqual({
      started: true,
      port: 3001,
      pid: 1234,
      reused: false,
      url: 'https://devbox.tail1234.ts.net:3001',
    })
  })

  it('runApp still succeeds when tailscale expose rejects', async () => {
    ;(deps.repos.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      installCmd: '',
      startCmd: 'pnpm dev',
    })
    ;(deps.tailscale!.expose as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    const result = (await rpc.handle(IPC.runApp, [{ repoId: 'r1', branch: 'main' }])) as {
      started: boolean
      url?: string
    }
    expect(result.started).toBe(true)
    expect(result.url).toBeUndefined()
  })

  it('stopApp tears down the tailscale mount for the key', async () => {
    await rpc.handle(IPC.stopApp, [{ repoId: 'r1', branch: 'main' }])
    expect(deps.tailscale!.unexpose).toHaveBeenCalledWith('r1 main')
  })

  it('appStatus reports the tailnet URL for a running app', async () => {
    ;(deps.appRunner.isRunning as ReturnType<typeof vi.fn>).mockReturnValueOnce(true)
    ;(deps.tailscale!.urlFor as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      'https://devbox.tail1234.ts.net:3001',
    )
    const result = await rpc.handle(IPC.appStatus, [{ repoId: 'r1', branch: 'main' }])
    expect(result).toEqual({ running: true, url: 'https://devbox.tail1234.ts.net:3001' })
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

    it("worktreeDiff throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.worktreeDiff, ['r1', 'b'])).rejects.toThrow('Unknown repo: r1')
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

  describe('prompt templates (FLO-98)', () => {
    function makeTemplate(overrides: Partial<PromptTemplateDTO> = {}): PromptTemplateDTO {
      return {
        id: 'tpl-1',
        repoId: 'r1',
        name: 'Bug fix kickoff',
        body: 'Fix the bug described in the ticket.',
        createdAt: 111,
        ownerId: 'local',
        ...overrides,
      }
    }

    it('listPromptTemplates requires an owned repo', async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
      await expect(rpc.handle(IPC.listPromptTemplates, ['nope'])).rejects.toThrow(
        'Unknown repo: nope',
      )
    })

    it("listPromptTemplates throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.listPromptTemplates, ['r1'])).rejects.toThrow('Unknown repo: r1')
    })

    it('listPromptTemplates filters out rows owned by another identity', async () => {
      deps.promptTemplates.upsert(makeTemplate({ id: 'mine', ownerId: 'local' }))
      deps.promptTemplates.upsert(makeTemplate({ id: 'legacy', ownerId: undefined })) // → local
      deps.promptTemplates.upsert(makeTemplate({ id: 'hers', ownerId: 'alice' }))
      const result = (await rpc.handle(IPC.listPromptTemplates, ['r1'])) as PromptTemplateDTO[]
      expect(result.map((t) => t.id).sort()).toEqual(['legacy', 'mine'])
    })

    it('savePromptTemplate mints an id, stamps ownerId, and returns the DTO', async () => {
      const result = (await rpc.handle(IPC.savePromptTemplate, [
        { repoId: 'r1', name: 'Kickoff', body: 'Do the thing.' },
      ])) as PromptTemplateDTO
      expect(result.id).toBeTruthy()
      expect(result.ownerId).toBe('local')
      expect(result.repoId).toBe('r1')
      expect(result.createdAt).toBeGreaterThan(0)
      expect(deps.promptTemplates.get(result.id)).toEqual(result)
    })

    it('savePromptTemplate rejects an empty name', async () => {
      await expect(
        rpc.handle(IPC.savePromptTemplate, [{ repoId: 'r1', name: '   ', body: 'Do it.' }]),
      ).rejects.toThrow(/name/i)
    })

    it('savePromptTemplate rejects an empty body', async () => {
      await expect(
        rpc.handle(IPC.savePromptTemplate, [{ repoId: 'r1', name: 'Kickoff', body: ' ' }]),
      ).rejects.toThrow(/body/i)
    })

    it('savePromptTemplate preserves createdAt when updating an owned template', async () => {
      deps.promptTemplates.upsert(makeTemplate({ id: 'tpl-1', createdAt: 111 }))
      const result = (await rpc.handle(IPC.savePromptTemplate, [
        { id: 'tpl-1', repoId: 'r1', name: 'Renamed', body: 'New body' },
      ])) as PromptTemplateDTO
      expect(result.createdAt).toBe(111)
      expect(deps.promptTemplates.get('tpl-1')?.name).toBe('Renamed')
    })

    it("savePromptTemplate throws Template not found for another identity's template", async () => {
      deps.promptTemplates.upsert(makeTemplate({ id: 'hers', ownerId: 'alice' }))
      await expect(
        rpc.handle(IPC.savePromptTemplate, [
          { id: 'hers', repoId: 'r1', name: 'Steal', body: 'nope' },
        ]),
      ).rejects.toThrow('Template not found: hers')
      expect(deps.promptTemplates.get('hers')?.name).toBe('Bug fix kickoff')
    })

    it('deletePromptTemplate throws the identical error for missing and other-owner rows', async () => {
      deps.promptTemplates.upsert(makeTemplate({ id: 'hers', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.deletePromptTemplate, ['missing'])).rejects.toThrow(
        'Template not found: missing',
      )
      await expect(rpc.handle(IPC.deletePromptTemplate, ['hers'])).rejects.toThrow(
        'Template not found: hers',
      )
      // no existence leak: the row is untouched
      expect(deps.promptTemplates.get('hers')).toBeTruthy()
    })

    it('deletePromptTemplate deletes an owned template', async () => {
      deps.promptTemplates.upsert(makeTemplate({ id: 'tpl-1' }))
      await rpc.handle(IPC.deletePromptTemplate, ['tpl-1'])
      expect(deps.promptTemplates.get('tpl-1')).toBeUndefined()
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
