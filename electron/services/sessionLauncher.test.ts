import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  IPortBroker,
  IRepoRegistry,
  ISessionManager,
  ISessionStore,
  ITicketProvider,
  IWorktreeManager,
  RepoDTO,
  SessionDTO,
  WorktreeInfo,
} from '../shared/contract.js'
import type { AgentCliDep } from './agentCliProvision.js'
import type { LaunchDeps, LaunchRequest } from './sessionLauncher.js'

// ── module under test (and its one async side-effect) ───────────────────────
// captureOpencodeSessionId shells out to the CLI and polls, so it's mocked
// out; the real usesEmbeddedServer / agentSessionEnv are pure and left alone.
vi.mock('./opencodeSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opencodeSessions.js')>()
  return { ...actual, captureOpencodeSessionId: vi.fn() }
})

const { launchSession } = await import('./sessionLauncher.js')
const { captureOpencodeSessionId } = await import('./opencodeSessions.js')
const captureSid = vi.mocked(captureOpencodeSessionId)

// ── fixtures ────────────────────────────────────────────────────────────────
const REPO: RepoDTO = {
  id: 'r1',
  org: 'acme',
  name: 'api',
  base: 'main',
  path: '/repo/.repositories/r1',
  ownerId: 'local',
}

function makeWorktree(branch = 'b1'): WorktreeInfo {
  return {
    branch,
    path: `/repo/.worktrees/r1-${branch}`,
    dirty: false,
    ahead: 0,
    behind: 0,
    added: 0,
    deleted: 0,
  }
}

function makeSessionDto(id: string, overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id,
    tid: 'FLO-1',
    title: 'Do the thing',
    prompt: 'do it',
    repoId: 'r1',
    branch: 'b1',
    status: 'running',
    createdAt: 0,
    ...overrides,
  }
}

function makeReq(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    sessionId: 's1',
    tid: 'FLO-1',
    title: 'Do the thing',
    prompt: 'do it',
    repoId: 'r1',
    branch: 'b1',
    systemPrompt: 'system',
    ownerId: 'local',
    ...overrides,
  }
}

function makeStore(): ISessionStore {
  const map = new Map<string, SessionDTO>()
  return {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    upsert: (s) => {
      map.set(s.id, s)
    },
    delete: (id) => {
      map.delete(id)
    },
  }
}

/** A full LaunchDeps built from vi.fn() spies; each method defaults to a happy
 *  value so a test only overrides the one it cares about. The sessionStore is a
 *  real in-memory ISessionStore so we can assert on what got persisted. */
function makeDeps(overrides: Partial<LaunchDeps> = {}): LaunchDeps {
  const sessionStore = makeStore()
  return {
    repos: {
      resolvePath: vi.fn(async () => REPO),
    } satisfies Pick<IRepoRegistry, 'resolvePath'>,
    worktrees: {
      create: vi.fn(async () => makeWorktree()),
      pathFor: vi.fn(() => '/repo/.worktrees/r1-b1'),
    } satisfies Pick<IWorktreeManager, 'create' | 'pathFor'>,
    sessions: {
      start: vi.fn(() => makeSessionDto('s1')),
      setOpencodeSid: vi.fn(),
    } satisfies Pick<ISessionManager, 'start' | 'setOpencodeSid'>,
    ports: { claim: vi.fn(async () => 3742) } satisfies IPortBroker,
    sessionStore,
    tickets: { startTicket: vi.fn(async () => null) } satisfies Pick<
      ITicketProvider,
      'startTicket'
    >,
    ...overrides,
  }
}

/** Flush the fire-and-forget captureOpencodeSessionId().then(...) microtask. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('launchSession — happy path', () => {
  beforeEach(() => {
    captureSid.mockReset()
  })

  it('runs the full launch procedure in order and returns the session with its port', async () => {
    const deps = makeDeps()
    const session = await launchSession(deps, makeReq())

    expect(session).toMatchObject({ id: 's1', port: 3742 })

    const resolvePath = deps.repos.resolvePath as ReturnType<typeof vi.fn>
    const create = deps.worktrees.create as ReturnType<typeof vi.fn>
    const pathFor = deps.worktrees.pathFor as ReturnType<typeof vi.fn>
    const claim = deps.ports.claim as ReturnType<typeof vi.fn>
    const start = deps.sessions.start as ReturnType<typeof vi.fn>

    expect(resolvePath).toHaveBeenCalledWith('r1')
    expect(create).toHaveBeenCalledWith(REPO, 'b1')
    expect(pathFor).toHaveBeenCalledWith(REPO, 'b1')
    // web is the only port claimed for a non-embedded backend
    expect(claim).toHaveBeenCalledTimes(1)
    expect(claim).toHaveBeenLastCalledWith('/repo/.worktrees/r1-b1', 'web')
    expect(start).toHaveBeenCalledOnce()
  })

  it('persists the row with port, agentKind and ownerId', async () => {
    const deps = makeDeps()
    await launchSession(deps, makeReq({ agentKind: 'claude-code' }))

    const row = deps.sessionStore.get('s1')
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      id: 's1',
      port: 3742,
      agentKind: 'claude-code',
      ownerId: 'local',
    })
  })

  it('defaults agentKind to claude-code in the persisted row', async () => {
    const deps = makeDeps()
    await launchSession(deps, makeReq({ agentKind: undefined }))

    expect(deps.sessionStore.get('s1')?.agentKind).toBe('claude-code')
  })

  it('transitions the ticket to "in progress"', async () => {
    const deps = makeDeps()
    await launchSession(deps, makeReq({ tid: 'FLO-9', src: 'linear' }))

    expect(deps.tickets.startTicket).toHaveBeenCalledWith('FLO-9', 'linear')
  })

  it('builds the PTY env from agentSessionEnv (PORT only when no agentCli)', async () => {
    const deps = makeDeps()
    await launchSession(deps, makeReq())

    const start = deps.sessions.start as ReturnType<typeof vi.fn>
    const input = start.mock.calls[0][0] as { env?: Record<string, string> }
    // No agentCli provided → only the claimed port leaks into env.
    expect(input.env).toEqual({ PORT: '3742' })
  })

  it('threads agentCli identity vars into the PTY env when provided', async () => {
    const agentCli: AgentCliDep = {
      binDir: '/data/bin',
      cliJsPath: '/data/cli.js',
      electronPath: '/electron',
      dataDir: '/data',
    }
    const deps = makeDeps({ agentCli })
    await launchSession(deps, makeReq())

    const start = deps.sessions.start as ReturnType<typeof vi.fn>
    const env = (start.mock.calls[0][0] as { env: Record<string, string> }).env
    expect(env.SLIPSTREAM_DATA_DIR).toBe('/data')
    expect(env.SLIPSTREAM_SESSION_ID).toBe('s1')
    expect(env.SLIPSTREAM_BASE).toBe('main')
    expect(env.SLIPSTREAM_BRANCH).toBe('b1')
    expect(env.PORT).toBe('3742')
    expect(env.PATH).toContain('/data/bin')
  })

  it('does NOT claim an opencode port or capture a sid for a PTY backend (claude-code)', async () => {
    const deps = makeDeps()
    await launchSession(deps, makeReq({ agentKind: 'claude-code' }))

    expect(deps.ports.claim).toHaveBeenCalledTimes(1) // 'web' only
    expect(captureSid).not.toHaveBeenCalled()
    expect(deps.sessions.setOpencodeSid).not.toHaveBeenCalled()
  })
})

describe('launchSession — port claim (swallow-if-absent)', () => {
  it('swallows a web port-claim failure and still launches (port undefined)', async () => {
    const deps = makeDeps()
    ;(deps.ports.claim as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('portBroker: floo claim failed: spawn floo ENOENT'),
    )

    const session = await launchSession(deps, makeReq())

    expect(session.port).toBeUndefined()
    expect(deps.sessions.start).toHaveBeenCalledOnce()
    expect(deps.sessionStore.get('s1')?.port).toBeUndefined()
  })
})

describe('launchSession — embedded-server (opencode/kilo) path', () => {
  beforeEach(() => {
    // captureOpencodeSessionId always returns a Promise in production (it polls
    // then resolves null); reset call history and default the mock to the same
    // so a bare call's `.then()` never blows up. Tests override as needed.
    captureSid.mockReset()
    captureSid.mockResolvedValue(null)
  })

  it('claims a second port for the embedded server and starts capture', async () => {
    const deps = makeDeps()
    ;(deps.ports.claim as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(3742) // web
      .mockResolvedValueOnce(4999) // opencode embedded server

    await launchSession(deps, makeReq({ agentKind: 'opencode' }))

    expect(deps.ports.claim).toHaveBeenCalledTimes(2)
    expect(deps.ports.claim).toHaveBeenNthCalledWith(2, '/repo/.worktrees/r1-b1', 'opencode')

    const start = deps.sessions.start as ReturnType<typeof vi.fn>
    expect((start.mock.calls[0][0] as { opencodePort?: number }).opencodePort).toBe(4999)
    expect(captureSid).toHaveBeenCalledOnce()
    expect(captureSid).toHaveBeenCalledWith({ cwd: '/repo/.worktrees/r1-b1', bin: undefined })
  })

  it('passes the kilo binary to captureOpencodeSessionId for the kilo backend', async () => {
    const deps = makeDeps()
    await launchSession(deps, makeReq({ agentKind: 'kilo' }))

    expect(captureSid).toHaveBeenCalledOnce()
    expect(captureSid.mock.calls[0][0]).toMatchObject({ bin: expect.stringMatching(/kilo$/) })
  })

  it('writes back the captured sid to the session manager and store', async () => {
    captureSid.mockResolvedValue('opencode-sid-42')
    const deps = makeDeps()
    await launchSession(deps, makeReq({ agentKind: 'opencode' }))
    await flushMicrotasks()

    expect(deps.sessions.setOpencodeSid).toHaveBeenCalledWith('s1', 'opencode-sid-42')
    expect(deps.sessionStore.get('s1')?.opencodeSid).toBe('opencode-sid-42')
  })

  it('does NOT write back when no sid was captured', async () => {
    captureSid.mockResolvedValue(null)
    const deps = makeDeps()
    await launchSession(deps, makeReq({ agentKind: 'opencode' }))
    await flushMicrotasks()

    expect(deps.sessions.setOpencodeSid).not.toHaveBeenCalled()
    expect(deps.sessionStore.get('s1')?.opencodeSid).toBeUndefined()
  })

  it('swallows an embedded-server port-claim failure (opencodePort undefined)', async () => {
    const deps = makeDeps()
    ;(deps.ports.claim as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(3742) // web ok
      .mockRejectedValueOnce(new Error('floo claim failed')) // embedded fails

    await launchSession(deps, makeReq({ agentKind: 'opencode' }))

    const start = deps.sessions.start as ReturnType<typeof vi.fn>
    expect((start.mock.calls[0][0] as { opencodePort?: number }).opencodePort).toBeUndefined()
    expect(deps.sessionStore.get('s1')?.status).toBe('running')
  })

  it('launch resolves BEFORE sid capture resolves (capture is fire-and-forget)', async () => {
    // captureOpencodeSessionId is a detached `void ... .then(...)` — the agent
    // is live the instant the PTY spawns, so the launch must NOT block on sid
    // capture (which polls the CLI for several seconds). A never-resolving
    // capture proves launch isn't awaiting it.
    captureSid.mockReturnValue(
      new Promise<string | null>(() => {
        /* never resolves */
      }),
    )
    const deps = makeDeps()

    await expect(launchSession(deps, makeReq({ agentKind: 'opencode' }))).resolves.toMatchObject({
      id: 's1',
    })
    expect(deps.sessionStore.get('s1')?.status).toBe('running')
    expect(deps.sessions.setOpencodeSid).not.toHaveBeenCalled() // capture never settled
  })
})

describe('launchSession — failure ordering / rollback', () => {
  beforeEach(() => {
    captureSid.mockReset()
  })

  it('propagates a resolvePath failure before ANY worktree/port/spawn work', async () => {
    const deps = makeDeps()
    ;(deps.repos.resolvePath as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('repo not found'),
    )

    await expect(launchSession(deps, makeReq())).rejects.toThrow('repo not found')

    expect(deps.worktrees.create).not.toHaveBeenCalled()
    expect(deps.ports.claim).not.toHaveBeenCalled()
    expect(deps.sessions.start).not.toHaveBeenCalled()
    expect(deps.tickets.startTicket).not.toHaveBeenCalled()
    expect(deps.sessionStore.get('s1')).toBeUndefined()
  })

  it('propagates a worktree.create failure before port/spawn/persist', async () => {
    const deps = makeDeps()
    ;(deps.worktrees.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('worktree conflict'),
    )

    await expect(launchSession(deps, makeReq())).rejects.toThrow('worktree conflict')

    expect(deps.ports.claim).not.toHaveBeenCalled()
    expect(deps.sessions.start).not.toHaveBeenCalled()
    expect(deps.sessionStore.get('s1')).toBeUndefined()
    expect(deps.tickets.startTicket).not.toHaveBeenCalled()
  })

  // The core "what's rolled back?" question from FLO-139: when the worktree is
  // created + port claimed but the PTY spawn (sessions.start) throws, the
  // launcher does NOT roll the worktree back — it propagates the error and
  // leaves cleanup to the caller (rpc's error path / the session reaper). It
  // must NOT persist a row, capture a sid, or transition the ticket.
  it('propagates a spawn (sessions.start) failure WITHOUT persisting, capturing a sid, or transitioning the ticket', async () => {
    const deps = makeDeps()
    ;(deps.sessions.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('spawn: ENOENT claude')
    })

    await expect(launchSession(deps, makeReq())).rejects.toThrow('spawn: ENOENT claude')

    // worktree + port had already happened before spawn…
    expect(deps.worktrees.create).toHaveBeenCalledOnce()
    expect(deps.ports.claim).toHaveBeenCalledOnce()
    // …but nothing downstream committed:
    expect(deps.sessionStore.get('s1')).toBeUndefined()
    expect(deps.tickets.startTicket).not.toHaveBeenCalled()
    expect(captureSid).not.toHaveBeenCalled()
  })

  it('swallows a ticket-transition failure (best-effort) — launch still succeeds', async () => {
    const deps = makeDeps()
    ;(deps.tickets.startTicket as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('linear 503'),
    )

    const session = await launchSession(deps, makeReq())
    expect(session.id).toBe('s1')
    expect(deps.sessionStore.get('s1')?.status).toBe('running')
  })
})
