import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRpc } from './rpc.js'
import type { IpcDeps } from '../ipc.js'
import { IPC, BACKEND_KINDS } from '../shared/contract.js'
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
  IClipboardStore,
  SessionStatus,
  StatusMeta,
  WriteLockState,
} from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'
import type { IEditorLauncher } from '../services/editorLauncher.js'
import type { IPushService } from '../services/pushService.js'
import { createWriteCoordinator } from '../services/writeCoordinator.js'
import type { IWriteCoordinator } from '../services/writeCoordinator.js'
import type { ISessionScheduler } from '../services/sessionScheduler.js'
import { piSessionDirFor } from '../services/piSessions.js'

vi.mock('../services/opencodeSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/opencodeSessions.js')>()
  return { ...actual, fetchOpencodeMessages: vi.fn() }
})
const { fetchOpencodeMessages } = await import('../services/opencodeSessions.js')

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
    handoff: vi.fn().mockReturnValue(makeSession()),
    has: vi.fn().mockReturnValue(false),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    getBuffer: vi.fn().mockResolvedValue({ data: 'buffered output', seq: 15 }),
    setOpencodeSid: vi.fn(),
    getOpencodeState: vi.fn().mockReturnValue(undefined),
    subscribeChat: vi.fn(),
    unsubscribeChat: vi.fn(),
    dropChatClient: vi.fn(),
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
    isMerged: vi.fn().mockResolvedValue({ merged: false, ahead: -1 }),
    status: vi.fn().mockResolvedValue(makeWorktreeInfo()),
    updateFromBase: vi.fn(),
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
    getSettings: vi.fn().mockReturnValue({
      configured: false,
      scopeKeys: [],
      onlyMine: true,
      apiKey: '',
      baseUrl: '',
      email: '',
      apiToken: '',
    }),
    setSettings: vi.fn(),
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
    saveFcmToken: vi.fn().mockResolvedValue(undefined),
    deleteFcmToken: vi.fn().mockResolvedValue(undefined),
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

  const clipboardMap = new Map<string, Buffer>()
  const clipboardStore: IClipboardStore = {
    save: vi.fn((sessionId: string, data: Buffer) => {
      clipboardMap.set(sessionId, data)
    }),
    delete: vi.fn((sessionId: string) => {
      clipboardMap.delete(sessionId)
    }),
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
    clipboardStore,
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

  describe('syncClipboardImage (TASK-CWLL6)', () => {
    it('saves decoded PNG bytes for an owned session', async () => {
      deps.sessionStore.upsert(makeSession())
      const dataBase64 = Buffer.from('fake-png-bytes').toString('base64')
      await rpc.handle(IPC.syncClipboardImage, ['s1', dataBase64])
      expect(deps.clipboardStore!.save).toHaveBeenCalledWith(
        's1',
        Buffer.from(dataBase64, 'base64'),
      )
    })

    it("rejects for another identity's session", async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      const dataBase64 = Buffer.from('fake-png-bytes').toString('base64')
      await expect(rpc.handle(IPC.syncClipboardImage, ['s1', dataBase64])).rejects.toThrow(
        /Session not found/,
      )
      expect(deps.clipboardStore!.save).not.toHaveBeenCalled()
    })

    it('rejects an oversize payload (> 10 MiB)', async () => {
      deps.sessionStore.upsert(makeSession())
      const big = Buffer.alloc(10 * 1024 * 1024 + 1)
      const dataBase64 = big.toString('base64')
      await expect(rpc.handle(IPC.syncClipboardImage, ['s1', dataBase64])).rejects.toThrow(/10 MiB/)
      expect(deps.clipboardStore!.save).not.toHaveBeenCalled()
    })

    it('rejects invalid base64', async () => {
      deps.sessionStore.upsert(makeSession())
      await expect(
        rpc.handle(IPC.syncClipboardImage, ['s1', 'not-valid-base64!!!']),
      ).rejects.toThrow(/[Ii]nvalid base64/)
      expect(deps.clipboardStore!.save).not.toHaveBeenCalled()
    })

    it('cleanupSession deletes the persisted clipboard image', async () => {
      await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
      ])
      await rpc.handle(IPC.cleanupSession, ['s1'])
      expect(deps.clipboardStore!.delete).toHaveBeenCalledWith('s1')
    })
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

  describe('chat messages (TASK-FPH60)', () => {
    // getChatMessages reads transcripts from claudeProjectsDir(), which honors
    // CLAUDE_CONFIG_DIR — same fixture-writing approach as the usage suite above.
    let configDir: string
    let prevConfigDir: string | undefined

    function chatLine(
      uuid: string,
      ts: string,
      text: string,
      role: 'user' | 'assistant' = 'assistant',
    ): string {
      return JSON.stringify({
        type: role,
        isSidechain: false,
        uuid,
        timestamp: ts,
        message: { role, content: [{ type: 'text', text }] },
      })
    }

    function writeTranscript(id: string, lines: string[]): void {
      const sub = path.join(configDir, 'projects', 'proj-a')
      fs.mkdirSync(sub, { recursive: true })
      fs.writeFileSync(path.join(sub, `${id}.jsonl`), lines.join('\n') + '\n')
    }

    beforeEach(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-rpc-chat-'))
      prevConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = configDir
    })

    afterEach(() => {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      fs.rmSync(configDir, { recursive: true, force: true })
    })

    it('getChatMessages returns available:true with parsed messages for a claude-code session', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      writeTranscript('s1', [
        chatLine('u1', '2026-07-19T10:00:00.000Z', 'hi', 'user'),
        chatLine('a1', '2026-07-19T10:00:01.000Z', 'hello'),
      ])

      const result = (await rpc.handle(IPC.getChatMessages, ['s1'])) as {
        available: boolean
        messages: { uuid: string }[]
      }
      expect(result.available).toBe(true)
      expect(result.messages.map((m) => m.uuid)).toEqual(['u1', 'a1'])
    })

    it('getChatMessages returns available:false when no transcript exists yet', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'pre-turn', agentKind: 'claude-code' }))
      const result = (await rpc.handle(IPC.getChatMessages, ['pre-turn'])) as {
        available: boolean
        messages: unknown[]
      }
      expect(result.available).toBe(false)
      expect(result.messages).toEqual([])
    })

    it('getChatMessages returns available:false for a non-claude-code session, even with a same-id file on disk', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'opencode' }))
      writeTranscript('s1', [chatLine('a1', '2026-07-19T10:00:00.000Z', 'hello')])

      const result = (await rpc.handle(IPC.getChatMessages, ['s1'])) as { available: boolean }
      expect(result.available).toBe(false)
    })

    it('getChatMessages rejects for a session the caller does not own', async () => {
      deps.sessionStore.upsert(
        makeSession({ id: 'hers', ownerId: 'alice', agentKind: 'claude-code' }),
      )
      await expect(rpc.handle(IPC.getChatMessages, ['hers'])).rejects.toThrow(/Session not found/)
    })

    it('getChatMessages caps to the most recent `limit` messages (default 50)', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      const lines = Array.from({ length: 5 }, (_, i) =>
        chatLine(`m${i}`, `2026-07-19T10:00:0${i}.000Z`, `msg ${i}`),
      )
      writeTranscript('s1', lines)

      const result = (await rpc.handle(IPC.getChatMessages, ['s1', { limit: 2 }])) as {
        messages: { uuid: string }[]
      }
      expect(result.messages.map((m) => m.uuid)).toEqual(['m3', 'm4'])
    })

    it('getChatMessages pages older messages via opts.beforeTs', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      writeTranscript('s1', [
        chatLine('m0', '2026-07-19T10:00:00.000Z', 'msg 0'),
        chatLine('m1', '2026-07-19T10:00:01.000Z', 'msg 1'),
        chatLine('m2', '2026-07-19T10:00:02.000Z', 'msg 2'),
      ])

      const result = (await rpc.handle(IPC.getChatMessages, [
        's1',
        { beforeTs: Date.parse('2026-07-19T10:00:02.000Z') },
      ])) as { messages: { uuid: string }[] }
      expect(result.messages.map((m) => m.uuid)).toEqual(['m0', 'm1'])
    })

    it('fans out chatMessage session events on the push channel', () => {
      const msg = { uuid: 'a1', role: 'assistant', blocks: [], ts: 5 }
      deps._emit('chatMessage', 's1', msg)
      expect(emitted).toContainEqual([IPC.sessionChatMessage, 's1', msg])
    })
  })

  describe('chat messages — pi (TASK-FPH60 extension)', () => {
    let piRoot: string
    let prevPiSessionDir: string | undefined
    const cwd = '/wt/t-1-fix-bug' // matches the mocked worktrees.pathFor return

    function piChatLine(id: string, ts: string, text: string, role: 'user' | 'assistant'): string {
      return JSON.stringify({
        type: 'message',
        id,
        parentId: null,
        timestamp: ts,
        message: { role, content: [{ type: 'text', text }] },
      })
    }

    beforeEach(() => {
      piRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-rpc-pi-chat-'))
      prevPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
      process.env.PI_CODING_AGENT_SESSION_DIR = piRoot
    })

    afterEach(() => {
      if (prevPiSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = prevPiSessionDir
      fs.rmSync(piRoot, { recursive: true, force: true })
    })

    it('returns available:true with parsed messages for a pi session', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'pi-1', repoId: 'r1', agentKind: 'pi' }))
      const dir = piSessionDirFor(cwd, piRoot)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'run1.jsonl'),
        [
          piChatLine('u1', '2026-07-19T10:00:00.000Z', 'hi', 'user'),
          piChatLine('a1', '2026-07-19T10:00:01.000Z', 'hello', 'assistant'),
        ].join('\n') + '\n',
      )

      const result = (await rpc.handle(IPC.getChatMessages, ['pi-1'])) as {
        available: boolean
        messages: { uuid: string }[]
      }
      expect(result.available).toBe(true)
      expect(result.messages.map((m) => m.uuid)).toEqual(['u1', 'a1'])
    })

    it('returns available:false when no pi session file exists yet', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'pi-1', repoId: 'r1', agentKind: 'pi' }))
      const result = (await rpc.handle(IPC.getChatMessages, ['pi-1'])) as { available: boolean }
      expect(result.available).toBe(false)
    })
  })

  describe('chat messages — opencode (TASK-FPH60 extension)', () => {
    beforeEach(() => {
      vi.mocked(fetchOpencodeMessages).mockReset()
      vi.mocked(deps.sessions.getOpencodeState!).mockReset()
    })

    it('returns available:false when the sid/port have not been captured yet', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'oc-1', agentKind: 'opencode' }))
      vi.mocked(deps.sessions.getOpencodeState!).mockReturnValue(undefined)

      const result = (await rpc.handle(IPC.getChatMessages, ['oc-1'])) as { available: boolean }
      expect(result.available).toBe(false)
      expect(fetchOpencodeMessages).not.toHaveBeenCalled()
    })

    it('returns available:true with mapped messages once sid/port are known', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'oc-1', agentKind: 'opencode' }))
      vi.mocked(deps.sessions.getOpencodeState!).mockReturnValue({ port: 4001, sid: 'ses_1' })
      vi.mocked(fetchOpencodeMessages).mockResolvedValue([
        {
          info: { id: 'm1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'hi' }],
        },
      ])

      const result = (await rpc.handle(IPC.getChatMessages, ['oc-1'])) as {
        available: boolean
        messages: { uuid: string }[]
      }
      expect(fetchOpencodeMessages).toHaveBeenCalledWith(4001, 'ses_1')
      expect(result.available).toBe(true)
      expect(result.messages.map((m) => m.uuid)).toEqual(['m1'])
    })

    it('returns available:true with mapped messages for a kilo session (shares the embedded-server branch)', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'kilo-1', agentKind: 'kilo' }))
      vi.mocked(deps.sessions.getOpencodeState!).mockReturnValue({ port: 4001, sid: 'ses_1' })
      vi.mocked(fetchOpencodeMessages).mockResolvedValue([
        {
          info: { id: 'm1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'hi' }],
        },
      ])

      const result = (await rpc.handle(IPC.getChatMessages, ['kilo-1'])) as {
        available: boolean
        messages: { uuid: string }[]
      }
      expect(fetchOpencodeMessages).toHaveBeenCalledWith(4001, 'ses_1')
      expect(result.available).toBe(true)
      expect(result.messages.map((m) => m.uuid)).toEqual(['m1'])
    })
  })

  describe('subscribeChat / unsubscribeChat (TASK-FPH60)', () => {
    it('subscribeChat delegates to sessions.subscribeChat with the caller-owned session', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      await rpc.handle(IPC.subscribeChat, ['s1'])
      expect(deps.sessions.subscribeChat).toHaveBeenCalledWith('s1', expect.any(String))
    })

    it('unsubscribeChat delegates to sessions.unsubscribeChat with the caller-owned session', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      await rpc.handle(IPC.unsubscribeChat, ['s1'])
      expect(deps.sessions.unsubscribeChat).toHaveBeenCalledWith('s1', expect.any(String))
    })

    it('subscribeChat no-ops for a session the caller does not own', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      await rpc.handle(IPC.subscribeChat, ['hers'])
      expect(deps.sessions.subscribeChat).not.toHaveBeenCalled()
    })

    it('dispose() drops this client from every session chat subscription', () => {
      rpc.dispose()
      expect(deps.sessions.dropChatClient).toHaveBeenCalled()
    })
  })

  describe('listAgentSkills (TASK-FPH60)', () => {
    let root: string
    let cwdDir: string
    let prevHome: string | undefined

    function writeSkill(dir: string, name: string): void {
      const skillDir = path.join(dir, name)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: desc for ${name}\n---\n`,
      )
    }

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-rpc-skills-'))
      cwdDir = path.join(root, 'cwd')
      fs.mkdirSync(cwdDir, { recursive: true })
      prevHome = process.env.HOME
      process.env.HOME = path.join(root, 'home')
      fs.mkdirSync(process.env.HOME, { recursive: true })
      vi.mocked(deps.worktrees.pathFor).mockReturnValue(cwdDir)
    })

    afterEach(() => {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      fs.rmSync(root, { recursive: true, force: true })
      vi.mocked(deps.worktrees.pathFor).mockReturnValue('/wt/t-1-fix-bug')
    })

    it('lists claude-code skills resolved from the session worktree', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      writeSkill(path.join(cwdDir, '.claude', 'skills'), 'my-skill')

      const result = await rpc.handle(IPC.listAgentSkills, ['s1'])
      expect(result).toEqual([
        { name: 'my-skill', description: 'desc for my-skill', source: 'project' },
      ])
    })

    it('rejects for a session the caller does not own', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.listAgentSkills, ['hers'])).rejects.toThrow(/Session not found/)
    })

    it('returns [] for a backend with no skills convention', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'grok' }))
      writeSkill(path.join(cwdDir, '.claude', 'skills'), 'irrelevant')
      expect(await rpc.handle(IPC.listAgentSkills, ['s1'])).toEqual([])
    })
  })

  describe('usage (pi backend, cwd-based, FLO-94 parity)', () => {
    let piRoot: string
    let prevPiSessionDir: string | undefined

    function writePiTurn(cwd: string, opts: { input?: number; output?: number } = {}): void {
      const dir = piSessionDirFor(cwd, piRoot)
      fs.mkdirSync(dir, { recursive: true })
      const line = JSON.stringify({
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: {
            input: opts.input ?? 0,
            output: opts.output ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            cost: { total: 0.01 },
          },
        },
      })
      fs.writeFileSync(path.join(dir, 'run1.jsonl'), line)
    }

    beforeEach(() => {
      piRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-rpc-pi-usage-'))
      prevPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
      process.env.PI_CODING_AGENT_SESSION_DIR = piRoot
    })

    afterEach(() => {
      if (prevPiSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = prevPiSessionDir
      fs.rmSync(piRoot, { recursive: true, force: true })
    })

    it('sessionUsage resolves cwd via repos/worktrees and reads pi usage', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'pi-1', repoId: 'r1', agentKind: 'pi' }))
      const cwd = deps.worktrees.pathFor(makeRepo(), 't-1-fix-bug') // matches the mocked pathFor return
      writePiTurn(cwd, { input: 10, output: 5 })

      const result = (await rpc.handle(IPC.sessionUsage, ['pi-1'])) as {
        exists: boolean
        turns: number
      }
      expect(deps.repos.resolvePath).toHaveBeenCalledWith('r1')
      expect(result.exists).toBe(true)
      expect(result.turns).toBe(1)
    })

    it('sessionUsage for a claude-code session never resolves a cwd', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', repoId: 'r1', agentKind: 'claude-code' }))
      await rpc.handle(IPC.sessionUsage, ['s1'])
      expect(deps.repos.resolvePath).not.toHaveBeenCalled()
    })

    it('usageSummary includes pi sessions using their resolved cwd', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'pi-1', repoId: 'r1', agentKind: 'pi' }))
      const cwd = deps.worktrees.pathFor(makeRepo(), 't-1-fix-bug')
      writePiTurn(cwd, { input: 10, output: 5 })

      const result = (await rpc.handle(IPC.usageSummary, [])) as {
        sessions: { sessionId: string }[]
      }
      expect(result.sessions.map((s) => s.sessionId)).toContain('pi-1')
    })
  })

  describe('session agent events (FLO-104)', () => {
    it('listSessionAgentEvents returns the stored events for an owned session', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      const events = [{ sessionId: 's1', kind: 'checkpoint', message: 'a', ts: 1 }]
      deps.agentEventStore = {
        insert: vi.fn(),
        list: vi.fn().mockReturnValue(events),
        delete: vi.fn(),
      }

      const result = await rpc.handle(IPC.listSessionAgentEvents, ['s1'])
      expect(result).toEqual(events)
      expect(deps.agentEventStore.list).toHaveBeenCalledWith('s1')
    })

    it('listSessionAgentEvents rejects for a session the caller does not own', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice' }))
      deps.agentEventStore = { insert: vi.fn(), list: vi.fn(), delete: vi.fn() }

      await expect(rpc.handle(IPC.listSessionAgentEvents, ['hers'])).rejects.toThrow(
        /Session not found/,
      )
      expect(deps.agentEventStore.list).not.toHaveBeenCalled()
    })

    it('listSessionAgentEvents returns [] when no store is wired (test fallback)', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1' }))
      const result = await rpc.handle(IPC.listSessionAgentEvents, ['s1'])
      expect(result).toEqual([])
    })

    it('fans out agentEvent session events on the push channel', () => {
      const event = { sessionId: 's1', kind: 'approval', message: 'ok?', ts: 5 }
      deps._emit('agentEvent', 's1', event)
      expect(emitted).toContainEqual([IPC.sessionAgentEvent, event])
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
        deps.agentCli = {
          binDir: path.join(dataDir, 'bin'),
          cliJsPath: '/app/slipstream-cli.js',
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

      it('negative-caches a disk-fallback miss, but a store upsert in between still surfaces on the next call (store-check-first is never shadowed)', async () => {
        deps.sessionStore.upsert(makeSession({ id: 's1' }))

        // First call: no sentinel on disk, no store entry — negative-cached.
        const first = await rpc.handle(IPC.getSessionOutcome, ['s1'])
        expect(first).toBeNull()

        // Simulates the live sentinelWatcher/sessionPersistence listener
        // pushing a real outcome into the store out-of-band while this
        // connection stays open.
        deps.outcomeStore.upsert(makeOutcome({ sessionId: 's1' }))

        const second = await rpc.handle(IPC.getSessionOutcome, ['s1'])
        expect(second).toEqual(makeOutcome({ sessionId: 's1' }))
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

  describe('sessionPrStatus (FLO-96)', () => {
    it('returns null when the session has no prUrl', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', prUrl: undefined }))
      deps.prStatus = { get: vi.fn() }
      const result = await rpc.handle(IPC.sessionPrStatus, ['s1'])
      expect(result).toBeNull()
      expect(deps.prStatus.get).not.toHaveBeenCalled()
    })

    it('returns null when no prStatus service is configured', async () => {
      deps.sessionStore.upsert(
        makeSession({ id: 's1', prUrl: 'https://github.com/acme/api/pull/1' }),
      )
      const result = await rpc.handle(IPC.sessionPrStatus, ['s1'])
      expect(result).toBeNull()
    })

    it('delegates to prStatus.get for an owned session with a prUrl', async () => {
      const dto = {
        sessionId: 's1',
        url: 'https://github.com/acme/api/pull/1',
        host: 'github' as const,
        state: 'open' as const,
        ci: 'passed' as const,
        review: 'approved' as const,
        approvals: 1,
        checkedAt: 123,
      }
      deps.sessionStore.upsert(makeSession({ id: 's1', prUrl: dto.url }))
      deps.prStatus = { get: vi.fn().mockResolvedValue(dto) }
      const result = await rpc.handle(IPC.sessionPrStatus, ['s1'])
      expect(deps.prStatus.get).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1', prUrl: dto.url }),
      )
      expect(result).toEqual(dto)
    })

    it('rejects for a session the caller does not own', async () => {
      deps.sessionStore.upsert(makeSession({ id: 'hers', ownerId: 'alice', prUrl: 'x' }))
      deps.prStatus = { get: vi.fn() }
      await expect(rpc.handle(IPC.sessionPrStatus, ['hers'])).rejects.toThrow(/Session not found/)
    })

    it('rejects for a missing session', async () => {
      await expect(rpc.handle(IPC.sessionPrStatus, ['nope'])).rejects.toThrow(/Session not found/)
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

  it('forwards session status events with meta to emit as a 4th arg (FLO-104)', () => {
    const meta = { reason: 'input', message: 'needs a decision' } satisfies StatusMeta
    deps._emit('status', 's1', 'needs' satisfies SessionStatus, meta)
    expect(emitted).toEqual([[IPC.sessionStatus, 's1', 'needs', meta]])
  })

  it('forwards session exit events to emit (FLO-101)', () => {
    deps._emit('exit', 's1', 0)
    expect(emitted).toEqual([[IPC.sessionExit, 's1', 0]])
  })

  it('dispose() removes event listeners', () => {
    rpc.dispose()
    deps._emit('data', 's1', 'after dispose')
    expect(emitted).toHaveLength(0)
  })

  it('dispose() removes the exit listener (FLO-101)', () => {
    rpc.dispose()
    deps._emit('exit', 's1', 1)
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
    expect(offSpy).toHaveBeenCalledWith('exit', expect.any(Function))
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

  it('sessionMerged returns merged:false for an unknown session', async () => {
    const result = await rpc.handle(IPC.sessionMerged, ['nope'])
    expect(result).toEqual({ merged: false })
  })

  it('sessionMerged surfaces the git probe verdict', async () => {
    deps.sessionStore.upsert(makeSession())
    ;(
      deps.worktrees as unknown as { isMerged: ReturnType<typeof vi.fn> }
    ).isMerged.mockResolvedValueOnce({ merged: true, via: 'merge-commit', ahead: 2 })
    const result = await rpc.handle(IPC.sessionMerged, ['s1'])
    expect(deps.worktrees.isMerged).toHaveBeenCalledWith(makeRepo(), 't-1-fix-bug')
    expect(result).toEqual({ merged: true, via: 'merge-commit' })
  })

  it('sessionMerged treats ahead 0 + recorded PR as merged (rebase/FF merge)', async () => {
    deps.sessionStore.upsert(
      makeSession({ prUrl: 'https://gitlab.com/acme/api/-/merge_requests/7' }),
    )
    ;(
      deps.worktrees as unknown as { isMerged: ReturnType<typeof vi.fn> }
    ).isMerged.mockResolvedValueOnce({ merged: false, ahead: 0 })
    const result = await rpc.handle(IPC.sessionMerged, ['s1'])
    expect(result).toEqual({ merged: true, via: 'pr' })
  })

  it('sessionMerged does NOT treat a fresh branch without a PR as merged', async () => {
    deps.sessionStore.upsert(makeSession())
    ;(
      deps.worktrees as unknown as { isMerged: ReturnType<typeof vi.fn> }
    ).isMerged.mockResolvedValueOnce({ merged: false, ahead: 0 })
    const result = await rpc.handle(IPC.sessionMerged, ['s1'])
    expect(result).toEqual({ merged: false })
  })

  it('sessionMerged ignores PR evidence when the branch ref is missing (ahead -1)', async () => {
    deps.sessionStore.upsert(
      makeSession({ prUrl: 'https://gitlab.com/acme/api/-/merge_requests/7' }),
    )
    ;(
      deps.worktrees as unknown as { isMerged: ReturnType<typeof vi.fn> }
    ).isMerged.mockResolvedValueOnce({ merged: false, ahead: -1 })
    const result = await rpc.handle(IPC.sessionMerged, ['s1'])
    expect(result).toEqual({ merged: false })
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

  describe('handoffSession (FLO-102)', () => {
    it('calls sessions.handoff with the target agentKind and a handoff prompt containing the original prompt', async () => {
      deps.sessionStore.upsert(makeSession())

      const result = (await rpc.handle(IPC.handoffSession, ['s1', 'pi'])) as SessionDTO & {
        port?: number
      }

      expect(deps.sessions.handoff).toHaveBeenCalledWith(
        expect.objectContaining({
          agentKind: 'pi',
          handoffPrompt: expect.stringContaining('fix it'),
        }),
      )
      expect(result.id).toBe('s1')
      expect(deps.sessionStore.get('s1')?.status).toBe('running')
    })

    it('throws for a missing session', async () => {
      await expect(rpc.handle(IPC.handoffSession, ['missing', 'pi'])).rejects.toThrow(
        'Session not found: missing',
      )
    })

    it('throws not-found for a session owned by another identity', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', ownerId: 'alice' }))
      await expect(rpc.handle(IPC.handoffSession, ['s1', 'pi'])).rejects.toThrow(
        'Session not found: s1',
      )
      expect(deps.sessions.handoff).not.toHaveBeenCalled()
    })

    it('throws for a queued session and does not call sessions.handoff', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', status: 'queued' }))
      await expect(rpc.handle(IPC.handoffSession, ['s1', 'pi'])).rejects.toThrow()
      expect(deps.sessions.handoff).not.toHaveBeenCalled()
    })

    it('throws when the target agentKind equals the current agentKind', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      await expect(rpc.handle(IPC.handoffSession, ['s1', 'claude-code'])).rejects.toThrow()
      expect(deps.sessions.handoff).not.toHaveBeenCalled()
    })

    it('throws "Unknown agent kind: bogus" for a bogus kind', async () => {
      deps.sessionStore.upsert(makeSession())
      await expect(rpc.handle(IPC.handoffSession, ['s1', 'bogus'])).rejects.toThrow(
        'Unknown agent kind: bogus',
      )
      expect(deps.sessions.handoff).not.toHaveBeenCalled()
    })

    it('accepts "antigravity" and "grok" as handoff targets (BACKEND_KINDS parity)', async () => {
      expect(BACKEND_KINDS).toContain('antigravity')
      expect(BACKEND_KINDS).toContain('grok')

      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      await rpc.handle(IPC.handoffSession, ['s1', 'antigravity'])
      expect(deps.sessions.handoff).toHaveBeenCalledWith(
        expect.objectContaining({ agentKind: 'antigravity' }),
      )

      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      await rpc.handle(IPC.handoffSession, ['s1', 'grok'])
      expect(deps.sessions.handoff).toHaveBeenCalledWith(
        expect.objectContaining({ agentKind: 'grok' }),
      )
    })

    it('accepts "kilo" as a handoff target and claims a "kilo"-named embedded-server port', async () => {
      expect(BACKEND_KINDS).toContain('kilo')

      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      await rpc.handle(IPC.handoffSession, ['s1', 'kilo'])

      expect(deps.sessions.handoff).toHaveBeenCalledWith(
        expect.objectContaining({ agentKind: 'kilo' }),
      )
      // opencode/kilo are the only backends that claim an embedded-server
      // port (usesEmbeddedServer) — the port broker sees a 'kilo'-named claim
      // in addition to the always-present 'web' claim.
      expect(deps.ports.claim).toHaveBeenCalledWith(expect.any(String), 'kilo')
    })

    it('does not claim an embedded-server port when handing off to a non-embedded-server backend', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', agentKind: 'claude-code' }))
      vi.mocked(deps.ports.claim).mockClear()

      await rpc.handle(IPC.handoffSession, ['s1', 'pi'])

      expect(deps.ports.claim).not.toHaveBeenCalledWith(expect.any(String), 'kilo')
      expect(deps.ports.claim).not.toHaveBeenCalledWith(expect.any(String), 'opencode')
    })
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

  it('routes worktreeUpdateFromBase to worktrees.updateFromBase with resolved repo, branch, and mode', async () => {
    const updateResult = { updated: true, mode: 'merge' as const, info: makeWorktreeInfo() }
    ;(deps.worktrees.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updateResult)

    const result = await rpc.handle(IPC.worktreeUpdateFromBase, ['r1', 't-1-fix-bug', 'merge'])
    expect(deps.repos.get).toHaveBeenCalledWith('r1')
    expect(deps.worktrees.updateFromBase).toHaveBeenCalledWith(makeRepo(), 't-1-fix-bug', {
      mode: 'merge',
    })
    expect(result).toEqual(updateResult)
  })

  it('worktreeUpdateFromBase throws for unknown repo', async () => {
    ;(deps.repos as unknown as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValueOnce(
      undefined,
    )
    await expect(
      rpc.handle(IPC.worktreeUpdateFromBase, ['unknown', 'branch', 'rebase']),
    ).rejects.toThrow('Unknown repo: unknown')
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
    // resolvePath is idempotent/self-healing and is now called twice on the
    // direct-launch path (once in rpc.ts for the owner check, once inside
    // sessionLauncher.ts to get the RepoDTO for worktree creation) — both
    // calls resolve the same healed path in production, so mock it for every
    // call rather than just the first.
    ;(
      deps.repos as unknown as { resolvePath: ReturnType<typeof vi.fn> }
    ).resolvePath.mockResolvedValue(healed)
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

  it('cleanupSession does not reset the ticket when the session is done (TASK-5PVBM)', async () => {
    await rpc.handle(IPC.startSession, [
      { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
    ])
    // The agent finished: persist the session in the 'done' state.
    const persisted = deps.sessionStore.get('s1')!
    deps.sessionStore.upsert({ ...persisted, status: 'done' })
    const result = await rpc.handle(IPC.cleanupSession, ['s1'])
    expect(result).toEqual({ removed: true })
    expect(deps.tickets.resetTicket).not.toHaveBeenCalled()
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

  describe('slipstream CLI session env (FLO-104)', () => {
    const cliEnv = expect.objectContaining({
      SLIPSTREAM_DATA_DIR: '/data',
      SLIPSTREAM_SESSION_ID: 's1',
      PATH: expect.stringMatching(/^\/data\/bin:/) as unknown,
    }) as unknown

    beforeEach(() => {
      deps.agentCli = {
        binDir: '/data/bin',
        cliJsPath: '/app/slipstream-cli.js',
        electronPath: '/usr/bin/electron',
        dataDir: '/data',
      }
    })

    it('resumeSession passes the CLI identity env + PATH prepend to sessions.resume', async () => {
      deps.sessionStore.upsert(makeSession())
      ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)

      await rpc.handle(IPC.resumeSession, ['s1'])

      expect(deps.sessions.resume).toHaveBeenCalledWith(expect.objectContaining({ env: cliEnv }))
    })

    it('attachRemoteControl passes the CLI identity env', async () => {
      deps.sessionStore.upsert(makeSession())

      await rpc.handle(IPC.attachRemoteControl, ['s1'])

      expect(deps.sessions.attachRemoteControl).toHaveBeenCalledWith(
        expect.objectContaining({ env: cliEnv }),
      )
    })

    it('handoffSession passes the CLI identity env to sessions.handoff', async () => {
      deps.sessionStore.upsert(makeSession())

      await rpc.handle(IPC.handoffSession, ['s1', 'pi'])

      expect(deps.sessions.handoff).toHaveBeenCalledWith(expect.objectContaining({ env: cliEnv }))
    })

    it('never re-introduces a scrubbed daemon key through the CLI env', async () => {
      deps.sessionStore.upsert(makeSession())
      ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)

      await rpc.handle(IPC.resumeSession, ['s1'])

      const call = (deps.sessions.resume as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        env: Record<string, string>
      }
      expect(Object.keys(call.env)).not.toContain('SLIPSTREAM_TOKEN')
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

  describe('agent args (TASK-CMZUG)', () => {
    it('getAgentArgs/setAgentArgs round-trip; unset kinds are omitted', async () => {
      const store = new Map<string, string>()
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        store.get(key),
      )
      ;(deps.config.set as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string, v: string) => {
          store.set(key, v)
        },
      )

      await rpc.handle(IPC.setAgentArgs, [{ opencode: '--advisor --chrome' }])
      const result = await rpc.handle(IPC.getAgentArgs, [])

      expect(result).toEqual({ opencode: '--advisor --chrome' })
      for (const kind of BACKEND_KINDS) {
        if (kind !== 'opencode') expect(result).not.toHaveProperty(kind)
      }
    })

    it('setAgentArgs rejects a malformed value', async () => {
      await expect(
        rpc.handle(IPC.setAgentArgs, [{ opencode: '--x "unterminated' }]),
      ).rejects.toThrow()
    })

    it('setAgentArgs rejects the whole call without a partial write', async () => {
      const store = new Map<string, string>()
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        store.get(key),
      )
      ;(deps.config.set as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string, v: string) => {
          store.set(key, v)
        },
      )

      // Establish pre-call state with a successful save.
      await rpc.handle(IPC.setAgentArgs, [{ 'claude-code': '--pre-existing' }])

      // 'claude-code' sorts before 'opencode' in BACKEND_KINDS, so a naive
      // single-pass loop would persist the 'claude-code' change before hitting
      // the malformed 'opencode' entry and throwing.
      await expect(
        rpc.handle(IPC.setAgentArgs, [
          { 'claude-code': '--changed', opencode: '--x "unterminated' },
        ]),
      ).rejects.toThrow()

      const result = await rpc.handle(IPC.getAgentArgs, [])
      expect(result).toEqual({ 'claude-code': '--pre-existing' })
    })

    it('startSession with no extraArgs falls back to the saved per-agent default', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'agentArgs.opencode') return '--advisor'
        return undefined
      })

      await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1', agentKind: 'opencode' },
      ])

      expect(deps.sessions.start).toHaveBeenCalledWith(
        expect.objectContaining({ extraArgs: '--advisor' }),
      )
    })

    it('startSession with a non-blank per-run extraArgs overrides the saved default', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'agentArgs.opencode') return '--advisor'
        return undefined
      })

      await rpc.handle(IPC.startSession, [
        {
          tid: 'T-1',
          title: 'Fix bug',
          prompt: 'fix it',
          repoId: 'r1',
          agentKind: 'opencode',
          extraArgs: '--verbose',
        },
      ])

      expect(deps.sessions.start).toHaveBeenCalledWith(
        expect.objectContaining({ extraArgs: '--verbose' }),
      )
    })
  })

  describe('git hosts (TASK-7LGAO)', () => {
    it('getGitToken/setGitToken keep working for github and gitlab', async () => {
      await rpc.handle(IPC.setGitToken, ['github', 'ghp_tok'])
      expect(deps.config.set).toHaveBeenCalledWith('github.token', 'ghp_tok')
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockReturnValueOnce('ghp_tok')
      expect(await rpc.handle(IPC.getGitToken, ['github'])).toBe('ghp_tok')
    })

    it('getGitToken/setGitToken reject an unknown host', async () => {
      await expect(rpc.handle(IPC.getGitToken, ['notahost'])).rejects.toThrow('Invalid host')
      await expect(rpc.handle(IPC.setGitToken, ['notahost', 'x'])).rejects.toThrow('Invalid host')
    })

    it('listGitProviders returns all four registered providers', async () => {
      const result = (await rpc.handle(IPC.listGitProviders, [])) as Array<{
        id: string
        displayName: string
        needsUsername: boolean
        needsBaseUrl: boolean
      }>
      expect(result.map((p) => p.id)).toEqual(['github', 'gitlab', 'bitbucket', 'gitea'])
      const bitbucket = result.find((p) => p.id === 'bitbucket')
      expect(bitbucket).toMatchObject({ displayName: 'Bitbucket', needsUsername: true })
      const gitea = result.find((p) => p.id === 'gitea')
      expect(gitea).toMatchObject({ displayName: 'Gitea / Forgejo', needsBaseUrl: true })
    })

    it('getGitHostConfig reads token/username/baseUrl for a host, defaulting missing fields to null', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'bitbucket.token') return 'app-pw'
        if (key === 'bitbucket.username') return 'alice'
        return undefined
      })
      const result = await rpc.handle(IPC.getGitHostConfig, ['bitbucket'])
      expect(result).toEqual({ token: 'app-pw', username: 'alice', baseUrl: null })
    })

    it('setGitHostConfig writes only the provided fields', async () => {
      await rpc.handle(IPC.setGitHostConfig, ['gitea', { token: 'tok', baseUrl: 'https://git.x' }])
      expect(deps.config.set).toHaveBeenCalledWith('gitea.token', 'tok')
      expect(deps.config.set).toHaveBeenCalledWith('gitea.baseUrl', 'https://git.x')
      expect(deps.config.set).not.toHaveBeenCalledWith('gitea.username', expect.anything())
    })

    it('getGitHostConfig/setGitHostConfig reject an unknown host', async () => {
      await expect(rpc.handle(IPC.getGitHostConfig, ['notahost'])).rejects.toThrow('Invalid host')
      await expect(rpc.handle(IPC.setGitHostConfig, ['notahost', {}])).rejects.toThrow(
        'Invalid host',
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

    it('saveFcmToken stamps the caller identity as ownerId (TASK-I9S44)', async () => {
      await rpc.handle(IPC.saveFcmToken, [{ token: 'device-tok-1', platform: 'android' }])
      expect(deps.push.saveFcmToken).toHaveBeenCalledWith('local', {
        token: 'device-tok-1',
        platform: 'android',
      })
    })

    it('saveFcmToken stamps a non-default caller identity too', async () => {
      const aliceRpc = createRpc(deps, () => {}, { coalesceMs: 0, identity: { id: 'alice' } })
      await aliceRpc.handle(IPC.saveFcmToken, [{ token: 'device-tok-2', platform: 'ios' }])
      expect(deps.push.saveFcmToken).toHaveBeenCalledWith('alice', {
        token: 'device-tok-2',
        platform: 'ios',
      })
      aliceRpc.dispose()
    })

    it('deleteFcmToken scopes the delete to the caller identity', async () => {
      await rpc.handle(IPC.deleteFcmToken, ['device-tok-1'])
      expect(deps.push.deleteFcmToken).toHaveBeenCalledWith('local', 'device-tok-1')
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

    it("worktreeUpdateFromBase throws Unknown repo for another identity's repo", async () => {
      ;(deps.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeRepo({ id: 'r1', ownerId: 'alice' }),
      )
      await expect(rpc.handle(IPC.worktreeUpdateFromBase, ['r1', 'b', 'rebase'])).rejects.toThrow(
        'Unknown repo: r1',
      )
      expect(deps.worktrees.updateFromBase).not.toHaveBeenCalled()
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

  describe('scheduler (FLO-95)', () => {
    function makeFakeScheduler(): ISessionScheduler & {
      submit: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
      drain: ReturnType<typeof vi.fn>
    } {
      return {
        submit: vi.fn().mockImplementation(async () => makeSession()),
        cancel: vi.fn().mockReturnValue(false),
        drain: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
        stop: vi.fn(),
        queuedIds: vi.fn().mockReturnValue([]),
      }
    }

    it('startSession routes through scheduler.submit when a scheduler is present', async () => {
      const scheduler = makeFakeScheduler()
      scheduler.submit.mockResolvedValueOnce(makeSession({ id: 's1', status: 'queued' }))
      deps.scheduler = scheduler

      const result = (await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
      ])) as SessionDTO

      expect(scheduler.submit).toHaveBeenCalledWith(
        expect.objectContaining({ tid: 'T-1', title: 'Fix bug', repoId: 'r1', ownerId: 'local' }),
      )
      expect(deps.sessions.start).not.toHaveBeenCalled()
      expect(result.status).toBe('queued')
    })

    it('startSession does not call scheduler.submit when no scheduler is configured (direct launch)', async () => {
      await rpc.handle(IPC.startSession, [
        { tid: 'T-1', title: 'Fix bug', prompt: 'fix it', repoId: 'r1' },
      ])
      expect(deps.sessions.start).toHaveBeenCalled()
    })

    it('killSession cancels a queued session via the scheduler and marks it interrupted', async () => {
      const scheduler = makeFakeScheduler()
      scheduler.cancel.mockReturnValue(true)
      deps.scheduler = scheduler
      deps.sessionStore.upsert(makeSession({ id: 's1', status: 'queued' }))

      await rpc.handle(IPC.killSession, ['s1'])

      expect(scheduler.cancel).toHaveBeenCalledWith('s1')
      expect(deps.sessions.kill).not.toHaveBeenCalled()
      expect(deps.sessionStore.get('s1')?.status).toBe('interrupted')
    })

    it('killSession falls through to sessions.kill when the scheduler does not have it queued', async () => {
      const scheduler = makeFakeScheduler()
      scheduler.cancel.mockReturnValue(false)
      deps.scheduler = scheduler
      deps.sessionStore.upsert(makeSession({ id: 's1', status: 'running' }))

      await rpc.handle(IPC.killSession, ['s1'])

      expect(scheduler.cancel).toHaveBeenCalledWith('s1')
      expect(deps.sessions.kill).toHaveBeenCalledWith('s1')
    })

    it('resumeSession on a queued row returns it as-is without calling sessions.resume', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', status: 'queued' }))
      ;(deps.sessions as unknown as { has: ReturnType<typeof vi.fn> }).has.mockReturnValue(false)

      const result = (await rpc.handle(IPC.resumeSession, ['s1'])) as SessionDTO

      expect(result.status).toBe('queued')
      expect(deps.sessions.resume).not.toHaveBeenCalled()
      expect(deps.worktrees.pathFor).not.toHaveBeenCalled()
    })

    it('attachRemoteControl on a queued row returns it as-is without calling sessions.attachRemoteControl', async () => {
      deps.sessionStore.upsert(makeSession({ id: 's1', status: 'queued' }))

      const result = (await rpc.handle(IPC.attachRemoteControl, ['s1'])) as SessionDTO

      expect(result.status).toBe('queued')
      expect(deps.sessions.attachRemoteControl).not.toHaveBeenCalled()
    })

    it('setSchedulerPolicy persists the normalized policy via config.set', async () => {
      await rpc.handle(IPC.setSchedulerPolicy, [{ maxConcurrent: 3 }])
      expect(deps.config.set).toHaveBeenCalledWith(
        'scheduler.policy',
        JSON.stringify({ maxConcurrent: 3 }),
      )
    })

    it('getSchedulerPolicy reads the policy back through config.get', async () => {
      ;(deps.config.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        JSON.stringify({ maxConcurrent: 3 }),
      )
      const result = await rpc.handle(IPC.getSchedulerPolicy, [])
      expect(result).toEqual({ maxConcurrent: 3 })
    })

    it('setSchedulerPolicy triggers scheduler.drain (raising the cap frees slots)', async () => {
      const scheduler = makeFakeScheduler()
      deps.scheduler = scheduler
      await rpc.handle(IPC.setSchedulerPolicy, [{ maxConcurrent: 5 }])
      expect(scheduler.drain).toHaveBeenCalledOnce()
    })

    it('getSchedulerPolicy returns the default when unset', async () => {
      const result = await rpc.handle(IPC.getSchedulerPolicy, [])
      expect(result).toEqual({ maxConcurrent: 0 })
    })
  })
})
