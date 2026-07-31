import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import { createAgentSpawnService } from './agentSpawnService.js'
import type { AgentSpawnDeps, AgentSpawnScheduler } from './agentSpawnService.js'
import type { LaunchDeps, LaunchRequest } from './sessionLauncher.js'
import type { AgentResponse } from './agentRequestSentinel.js'
import type { IConfigStore } from './configStore.js'
import type {
  AgentRequest,
  BudgetPolicy,
  ISessionManager,
  ISessionStore,
  IOutcomeStore,
  IRepoRegistry,
  RepoDTO,
  SessionDTO,
  SessionOutcomeDTO,
  SessionUsage,
  SpawnPolicy,
} from '../shared/contract.js'

function makeRepo(overrides: Partial<RepoDTO> = {}): RepoDTO {
  return {
    id: 'acme-api',
    org: 'acme',
    name: 'api',
    base: 'main',
    path: '/repos/acme-api',
    ownerId: 'local',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'parent-1',
    tid: 'FLO-1',
    title: 'Parent session',
    prompt: 'do work',
    repoId: 'acme-api',
    branch: 'flo-1-parent-session',
    status: 'running',
    createdAt: Date.now(),
    ownerId: 'local',
    ...overrides,
  }
}

interface Fakes {
  emitter: EventEmitter
  sessionStore: ISessionStore
  repoList: RepoDTO[]
  outcomeMap: Map<string, SessionOutcomeDTO>
  responses: Record<string, AgentResponse[]>
  scheduler?: AgentSpawnScheduler
  /** Set/clear the persisted spawn.policy value the fake config store
   *  returns. Pass undefined to simulate an unset key (falls back to
   *  DEFAULT_SPAWN_POLICY), or a raw string to simulate malformed JSON. */
  setSpawnPolicy: (policy: Partial<SpawnPolicy> | string | undefined) => void
  /** Set/clear the persisted budget.policy value the fake config store
   *  returns. Pass undefined to simulate an unset key (falls back to
   *  DEFAULT_BUDGET_POLICY), or a raw string to simulate malformed JSON. */
  setBudgetPolicy: (policy: Partial<BudgetPolicy> | string | undefined) => void
  deps: AgentSpawnDeps
}

function makeFakes(
  opts: {
    withScheduler?: boolean
    getSessionUsage?: (session: SessionDTO) => Promise<SessionUsage & { supportsUsage: boolean }>
  } = {},
): Fakes {
  const emitter = new EventEmitter()
  const sessions: Pick<ISessionManager, 'on' | 'off'> = {
    on: (event, listener) => {
      emitter.on(event, listener as (...args: unknown[]) => void)
    },
    off: (event, listener) => {
      emitter.removeListener(event, listener as (...args: unknown[]) => void)
    },
  }

  const storeMap = new Map<string, SessionDTO>()
  const sessionStore: ISessionStore = {
    list: () => Array.from(storeMap.values()),
    get: (id) => storeMap.get(id),
    upsert: (s) => {
      storeMap.set(s.id, s)
    },
    delete: (id) => {
      storeMap.delete(id)
    },
  }

  const repoList: RepoDTO[] = []
  const repos: Pick<IRepoRegistry, 'list'> = {
    list: async () => repoList,
  }

  const outcomeMap = new Map<string, SessionOutcomeDTO>()
  const outcomeStore: Pick<IOutcomeStore, 'get'> = {
    get: (id) => outcomeMap.get(id),
  }

  const responses: Record<string, AgentResponse[]> = {}
  const writeResponse = vi.fn((parentSessionId: string, response: AgentResponse) => {
    ;(responses[parentSessionId] ??= []).push(response)
  })

  // Fakes for the no-scheduler immediate-launch branch: launchSession (the
  // real function, imported by agentSpawnService.ts) is exercised end to end
  // against these, so no Electron/DB/real fs is involved.
  const launchDeps: LaunchDeps = {
    repos: {
      resolvePath: async (id: string) => {
        const r = repoList.find((r) => r.id === id)
        if (!r) throw new Error(`Unknown repo: ${id}`)
        return r
      },
    },
    worktrees: {
      create: async () => ({
        branch: 'b',
        path: '/wt',
        dirty: false,
        ahead: 0,
        behind: 0,
        added: 0,
        deleted: 0,
      }),
      pathFor: () => '/wt',
    },
    sessions: {
      start: (input) => {
        const dto: SessionDTO = {
          id: input.sessionId ?? 'minted-session',
          tid: input.tid,
          title: input.title,
          prompt: input.prompt,
          repoId: input.repo.id,
          branch: input.branch,
          status: 'running',
          createdAt: Date.now(),
          agentKind: input.agentKind,
          src: input.src,
          parentId: input.parentId,
        }
        return dto
      },
      setOpencodeSid: () => {},
    },
    ports: {
      claim: async () => 1234,
    },
    sessionStore,
    tickets: (_ownerId: string) => ({
      startTicket: async () => null,
    }),
  }

  const scheduler: AgentSpawnScheduler | undefined = opts.withScheduler
    ? {
        submit: vi.fn(async (req: LaunchRequest) => {
          const dto: SessionDTO = {
            id: req.sessionId,
            tid: req.tid,
            title: req.title,
            prompt: req.prompt,
            repoId: req.repoId,
            branch: req.branch,
            status: 'running',
            createdAt: Date.now(),
            agentKind: req.agentKind,
            ownerId: req.ownerId,
            parentId: req.parentId,
          }
          sessionStore.upsert(dto)
          return dto
        }),
      }
    : undefined

  // Fake config store: defaults to no persisted policy (readSpawnPolicy /
  // readBudgetPolicy fall back to their DEFAULT_*), overridable per-test via
  // setSpawnPolicy / setBudgetPolicy.
  let spawnPolicyRaw: string | undefined
  let budgetPolicyRaw: string | undefined
  const config: Pick<IConfigStore, 'get'> = {
    get: (key: string) => {
      if (key === 'spawn.policy') return spawnPolicyRaw
      if (key === 'budget.policy') return budgetPolicyRaw
      return undefined
    },
  }
  const setSpawnPolicy = (policy: Partial<SpawnPolicy> | string | undefined): void => {
    spawnPolicyRaw =
      typeof policy === 'string' || policy === undefined ? policy : JSON.stringify(policy)
  }
  const setBudgetPolicy = (policy: Partial<BudgetPolicy> | string | undefined): void => {
    budgetPolicyRaw =
      typeof policy === 'string' || policy === undefined ? policy : JSON.stringify(policy)
  }

  // Default usage fake: no transcript/usage data for any session, but a
  // supported backend — matches readSessionUsage's real shape for a
  // pre-first-turn session. Tests override via opts.getSessionUsage.
  const getSessionUsage =
    opts.getSessionUsage ??
    (async (session: SessionDTO): Promise<SessionUsage & { supportsUsage: boolean }> => ({
      sessionId: session.id,
      exists: false,
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      costUsd: 0,
      turns: 0,
      supportsUsage: true,
    }))

  const deps: AgentSpawnDeps = {
    sessions,
    sessionStore,
    repos,
    outcomeStore,
    config,
    launchDeps,
    scheduler,
    dataDir: '/data',
    writeResponse,
    getSessionUsage,
  }

  return {
    emitter,
    sessionStore,
    repoList,
    outcomeMap,
    responses,
    scheduler,
    setSpawnPolicy,
    setBudgetPolicy,
    deps,
  }
}

/** Emit an agentRequest and wait for its response to land — the handler runs
 *  as a detached async IIFE (never awaited by the emitter), so tests must
 *  poll rather than await a return value. */
async function emitAndWaitForResponse(
  fakes: Fakes,
  sessionId: string,
  req: AgentRequest,
): Promise<AgentResponse> {
  fakes.emitter.emit('agentRequest', sessionId, req)
  await vi.waitFor(() => {
    const found = fakes.responses[sessionId]?.find((r) => r.id === req.id)
    if (!found) throw new Error('response not yet written')
  })
  return fakes.responses[sessionId].find((r) => r.id === req.id)!
}

describe('agentSpawnService — new-agent', () => {
  it('launches successfully via the scheduler when one is present', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-1',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: 'Do the thing',
      prompt: 'go',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(true)
    if (res.ok) {
      const data = res.data as { sessionId: string; tid: string; branch: string; repo: string }
      expect(data.repo).toBe('acme/api')
      expect(data.tid).toMatch(/^TASK-[A-Z0-9]{5}$/)
      expect(data.branch).toContain(data.tid)
    }
    expect(fakes.scheduler!.submit).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('launches successfully via launchSession directly when no scheduler is present', async () => {
    const fakes = makeFakes({ withScheduler: false })
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-2',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme-api', // bare repo id form
      title: 'Do another thing',
      prompt: 'go go',
      agent: 'claude-code',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(true)
    if (res.ok) {
      const data = res.data as { sessionId: string; repo: string; status: string }
      expect(data.repo).toBe('acme/api')
      expect(data.status).toBe('running')
    }
    service.dispose()
  })

  it('rejects an unknown repo', async () => {
    const fakes = makeFakes()
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-3',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'nope/nonexistent',
      title: 'Do the thing',
      prompt: 'go',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/unknown repo/i)
    service.dispose()
  })

  it('rejects a repo owned by a different owner', async () => {
    const fakes = makeFakes()
    fakes.sessionStore.upsert(makeSession({ ownerId: 'local' }))
    fakes.repoList.push(makeRepo({ ownerId: 'someone-else' }))
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-4',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: 'Do the thing',
      prompt: 'go',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/unknown repo/i)
    service.dispose()
  })

  it('rejects a blank title', async () => {
    const fakes = makeFakes()
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-5',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: '   ',
      prompt: 'go',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/title/i)
    service.dispose()
  })

  it('rejects an unknown agent kind', async () => {
    const fakes = makeFakes()
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-6',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: 'Do the thing',
      prompt: 'go',
      agent: 'not-a-real-agent',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/unknown agent kind/i)
    service.dispose()
  })

  it('responds ok:false without throwing when the requesting session is unknown', async () => {
    const fakes = makeFakes()
    // No session upserted for 'ghost' — sessionStore.get returns undefined.
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = {
      id: 'req-7',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: 'x',
      prompt: 'y',
    }
    fakes.emitter.emit('agentRequest', 'ghost', req)
    await vi.waitFor(() => {
      if (!fakes.responses['ghost']?.length) throw new Error('not yet')
    })
    expect(fakes.responses['ghost'][0].ok).toBe(false)
    service.dispose()
  })
})

describe('agentSpawnService — repos', () => {
  it('returns only repos owned by the requesting session owner', async () => {
    const fakes = makeFakes()
    fakes.sessionStore.upsert(makeSession({ ownerId: 'local' }))
    fakes.repoList.push(
      makeRepo({ id: 'mine-1', org: 'acme', name: 'api', ownerId: 'local' }),
      makeRepo({ id: 'mine-2', org: 'acme', name: 'web', ownerId: 'local' }),
      makeRepo({ id: 'theirs', org: 'other', name: 'thing', ownerId: 'someone-else' }),
    )
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = { id: 'req-8', kind: 'repos', ts: Date.now() }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(true)
    if (res.ok) {
      const data = res.data as Array<{ id: string }>
      expect(data.map((r) => r.id).sort()).toEqual(['mine-1', 'mine-2'])
    }
    service.dispose()
  })
})

describe('agentSpawnService — idempotency across a daemon restart (TASK-CIOEQ)', () => {
  it('never reprocesses a request whose response already exists at startup', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    // Simulate: this request was already answered in a previous daemon run —
    // responses.ndjson already has an entry for it before the service starts.
    fakes.responses['parent-1'] = [{ id: 'req-1', ok: true, ts: 1, data: { sessionId: 'old' } }]
    const deps: AgentSpawnDeps = {
      ...fakes.deps,
      readResponses: (parentSessionId) => fakes.responses[parentSessionId] ?? [],
    }
    const service = createAgentSpawnService(deps)

    const req: AgentRequest = {
      id: 'req-1',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: 'Do the thing',
      prompt: 'go',
    }
    fakes.emitter.emit('agentRequest', 'parent-1', req)

    // Give any (incorrect) async re-processing a chance to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fakes.scheduler!.submit).not.toHaveBeenCalled()
    // The seeded response is untouched — no second entry was appended.
    expect(fakes.responses['parent-1']).toHaveLength(1)
    service.dispose()
  })

  it('still processes a fresh request id normally', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.sessionStore.upsert(makeSession())
    fakes.repoList.push(makeRepo())
    fakes.responses['parent-1'] = [{ id: 'some-other-req', ok: true, ts: 1, data: {} }]
    const deps: AgentSpawnDeps = {
      ...fakes.deps,
      readResponses: (parentSessionId) => fakes.responses[parentSessionId] ?? [],
    }
    const service = createAgentSpawnService(deps)

    const req: AgentRequest = {
      id: 'req-fresh',
      kind: 'new-agent',
      ts: Date.now(),
      repo: 'acme/api',
      title: 'Do the thing',
      prompt: 'go',
    }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(true)
    expect(fakes.scheduler!.submit).toHaveBeenCalledTimes(1)
    service.dispose()
  })
})

describe('agentSpawnService — agents', () => {
  it('returns only sessions with matching parentId, including outcome when present', async () => {
    const fakes = makeFakes()
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1', ownerId: 'local' }))
    fakes.sessionStore.upsert(
      makeSession({ id: 'child-1', parentId: 'parent-1', title: 'Child one', status: 'done' }),
    )
    fakes.sessionStore.upsert(
      makeSession({ id: 'child-2', parentId: 'parent-1', title: 'Child two', status: 'running' }),
    )
    fakes.sessionStore.upsert(
      makeSession({ id: 'unrelated', parentId: 'some-other-parent', title: 'Not mine' }),
    )
    fakes.outcomeMap.set('child-1', {
      sessionId: 'child-1',
      result: 'success',
      summary: 'Shipped it',
      reportedAt: Date.now(),
    })
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const req: AgentRequest = { id: 'req-9', kind: 'agents', ts: Date.now() }
    const res = await emitAndWaitForResponse(fakes, 'parent-1', req)

    expect(res.ok).toBe(true)
    if (res.ok) {
      const data = res.data as Array<{
        sessionId: string
        outcome?: { result: string; summary: string }
      }>
      expect(data.map((a) => a.sessionId).sort()).toEqual(['child-1', 'child-2'])
      const child1 = data.find((a) => a.sessionId === 'child-1')!
      expect(child1.outcome).toEqual({ result: 'success', summary: 'Shipped it' })
      const child2 = data.find((a) => a.sessionId === 'child-2')!
      expect(child2.outcome).toBeUndefined()
    }
    service.dispose()
  })
})

function newAgentReq(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id: 'req-limit',
    kind: 'new-agent',
    ts: Date.now(),
    repo: 'acme/api',
    title: 'Do the thing',
    prompt: 'go',
    ...overrides,
  } as AgentRequest
}

describe('agentSpawnService — SpawnPolicy: maxDepth', () => {
  it('allows a spawn at exactly the depth limit', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 2, maxChildrenPerSession: 0, maxSpawnsPerHour: 0 })
    // root (depth 0) -> mid (depth 1); spawning from mid puts the new child
    // at depth 2, which is exactly the limit.
    fakes.sessionStore.upsert(makeSession({ id: 'root' }))
    fakes.sessionStore.upsert(makeSession({ id: 'mid', parentId: 'root' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(fakes, 'mid', newAgentReq({ id: 'req-depth-ok' }))

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('refuses a spawn that would exceed the depth limit', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 2, maxChildrenPerSession: 0, maxSpawnsPerHour: 0 })
    // root (0) -> mid (1) -> deep (2); spawning from deep would put the new
    // child at depth 3, over the limit of 2.
    fakes.sessionStore.upsert(makeSession({ id: 'root' }))
    fakes.sessionStore.upsert(makeSession({ id: 'mid', parentId: 'root' }))
    fakes.sessionStore.upsert(makeSession({ id: 'deep', parentId: 'mid' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(fakes, 'deep', newAgentReq({ id: 'req-depth-bad' }))

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/depth/i)
    expect(fakes.scheduler!.submit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('maxDepth: 0 means unlimited', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 0, maxSpawnsPerHour: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'root' }))
    fakes.sessionStore.upsert(makeSession({ id: 'mid', parentId: 'root' }))
    fakes.sessionStore.upsert(makeSession({ id: 'deep', parentId: 'mid' }))
    fakes.sessionStore.upsert(makeSession({ id: 'deeper', parentId: 'deep' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'deeper',
      newAgentReq({ id: 'req-depth-unlim' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })
})

describe('agentSpawnService — SpawnPolicy: maxChildrenPerSession', () => {
  it('allows a spawn under the children cap', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 2, maxSpawnsPerHour: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.sessionStore.upsert(makeSession({ id: 'child-1', parentId: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(fakes, 'parent-1', newAgentReq({ id: 'req-child-ok' }))

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('refuses a spawn at the children cap', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 2, maxSpawnsPerHour: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.sessionStore.upsert(makeSession({ id: 'child-1', parentId: 'parent-1' }))
    fakes.sessionStore.upsert(makeSession({ id: 'child-2', parentId: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-child-bad' }),
    )

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/child/i)
    expect(fakes.scheduler!.submit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('maxChildrenPerSession: 0 means unlimited', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 0, maxSpawnsPerHour: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    for (let i = 0; i < 10; i++) {
      fakes.sessionStore.upsert(makeSession({ id: `child-${i}`, parentId: 'parent-1' }))
    }
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-child-unlim' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })
})

describe('agentSpawnService — SpawnPolicy: maxSpawnsPerHour', () => {
  it('allows a spawn under the hourly rate cap', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 0, maxSpawnsPerHour: 2 })
    const nowMs = Date.now()
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.sessionStore.upsert(
      makeSession({ id: 'child-1', parentId: 'parent-1', createdAt: nowMs - 5 * 60_000 }),
    )
    fakes.repoList.push(makeRepo())
    const deps: AgentSpawnDeps = { ...fakes.deps, now: () => nowMs }
    const service = createAgentSpawnService(deps)

    const res = await emitAndWaitForResponse(fakes, 'parent-1', newAgentReq({ id: 'req-rate-ok' }))

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('refuses a spawn at the hourly rate cap, ignoring spawns older than an hour', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 0, maxSpawnsPerHour: 2 })
    const nowMs = Date.now()
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.sessionStore.upsert(
      makeSession({ id: 'child-1', parentId: 'parent-1', createdAt: nowMs - 5 * 60_000 }),
    )
    fakes.sessionStore.upsert(
      makeSession({ id: 'child-2', parentId: 'parent-1', createdAt: nowMs - 10 * 60_000 }),
    )
    // Outside the rolling hour window — must not count toward the cap.
    fakes.sessionStore.upsert(
      makeSession({ id: 'child-old', parentId: 'parent-1', createdAt: nowMs - 90 * 60_000 }),
    )
    fakes.repoList.push(makeRepo())
    const deps: AgentSpawnDeps = { ...fakes.deps, now: () => nowMs }
    const service = createAgentSpawnService(deps)

    const res = await emitAndWaitForResponse(fakes, 'parent-1', newAgentReq({ id: 'req-rate-bad' }))

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/hour/i)
    expect(fakes.scheduler!.submit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('maxSpawnsPerHour: 0 means unlimited', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 0, maxSpawnsPerHour: 0 })
    const nowMs = Date.now()
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    for (let i = 0; i < 10; i++) {
      fakes.sessionStore.upsert(
        makeSession({ id: `child-${i}`, parentId: 'parent-1', createdAt: nowMs - 60_000 }),
      )
    }
    fakes.repoList.push(makeRepo())
    const deps: AgentSpawnDeps = { ...fakes.deps, now: () => nowMs }
    const service = createAgentSpawnService(deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-rate-unlim' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })
})

describe('agentSpawnService — SpawnPolicy: read failure falls back to defaults', () => {
  it('falls back to DEFAULT_SPAWN_POLICY (not unlimited) on malformed persisted policy', async () => {
    const fakes = makeFakes({ withScheduler: true })
    // Malformed JSON — readSpawnPolicy must fall back to DEFAULT_SPAWN_POLICY
    // (maxDepth 2, maxChildrenPerSession 5, maxSpawnsPerHour 20), never to
    // unlimited (0/0/0), or this spawn (11th child) would wrongly succeed.
    fakes.setSpawnPolicy('{not valid json')
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    for (let i = 0; i < 5; i++) {
      fakes.sessionStore.upsert(makeSession({ id: `child-${i}`, parentId: 'parent-1' }))
    }
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(fakes, 'parent-1', newAgentReq({ id: 'req-fallback' }))

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/child/i)
    service.dispose()
  })
})

describe('agentSpawnService — SpawnPolicy refusal is durable across restart replay', () => {
  it('never reprocesses (and never retries) a request that was already refused', async () => {
    const fakes = makeFakes({ withScheduler: true })
    fakes.setSpawnPolicy({ maxDepth: 0, maxChildrenPerSession: 1, maxSpawnsPerHour: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.sessionStore.upsert(makeSession({ id: 'child-1', parentId: 'parent-1' }))
    // Simulate: this request was already refused in a previous daemon run —
    // responses.ndjson already has an ok:false entry for it before the
    // service starts (a refusal is an answer, seeded exactly like a success).
    fakes.responses['parent-1'] = [
      { id: 'req-refused', ok: false, ts: 1, error: 'Spawn refused: child limit' },
    ]
    const deps: AgentSpawnDeps = {
      ...fakes.deps,
      readResponses: (parentSessionId) => fakes.responses[parentSessionId] ?? [],
    }
    const service = createAgentSpawnService(deps)

    fakes.emitter.emit('agentRequest', 'parent-1', newAgentReq({ id: 'req-refused' }))

    // Give any (incorrect) async re-processing a chance to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fakes.scheduler!.submit).not.toHaveBeenCalled()
    // The seeded refusal is untouched — no second entry was appended.
    expect(fakes.responses['parent-1']).toHaveLength(1)
    expect(fakes.responses['parent-1'][0].ok).toBe(false)
    service.dispose()
  })
})

function fakeUsage(
  session: SessionDTO,
  overrides: Partial<SessionUsage & { supportsUsage: boolean }> = {},
): SessionUsage & { supportsUsage: boolean } {
  return {
    sessionId: session.id,
    exists: true,
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    costUsd: 0,
    turns: 1,
    supportsUsage: true,
    ...overrides,
  }
}

describe('agentSpawnService — daily budget cap', () => {
  it('proceeds when spend today is under the daily cap', async () => {
    const fakes = makeFakes({
      withScheduler: true,
      getSessionUsage: async (s) => fakeUsage(s, { costUsd: 1 }),
    })
    fakes.setBudgetPolicy({ enabled: true, dailyUsdCap: 10, perSessionUsdCap: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(fakes, 'parent-1', newAgentReq({ id: 'req-daily-ok' }))

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('refuses when spend today is at/over the daily cap', async () => {
    const fakes = makeFakes({
      withScheduler: true,
      getSessionUsage: async (s) => fakeUsage(s, { costUsd: 10 }),
    })
    fakes.setBudgetPolicy({ enabled: true, dailyUsdCap: 10, perSessionUsdCap: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-daily-bad' }),
    )

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/daily cap|estimated api spend/i)
    expect(fakes.scheduler!.submit).not.toHaveBeenCalled()
    service.dispose()
  })

  it('dailyUsdCap: 0 means unlimited, even with huge spend today', async () => {
    const fakes = makeFakes({
      withScheduler: true,
      getSessionUsage: async (s) => fakeUsage(s, { costUsd: 1_000_000 }),
    })
    fakes.setBudgetPolicy({ enabled: true, dailyUsdCap: 0, perSessionUsdCap: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-daily-unlim' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('enabled: false disables enforcement even with spend over the cap', async () => {
    const fakes = makeFakes({
      withScheduler: true,
      getSessionUsage: async (s) => fakeUsage(s, { costUsd: 1_000_000 }),
    })
    fakes.setBudgetPolicy({ enabled: false, dailyUsdCap: 1, perSessionUsdCap: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-daily-disabled' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('a malformed stored budget.policy coerces to default (disabled) — spawn proceeds', async () => {
    const fakes = makeFakes({
      withScheduler: true,
      getSessionUsage: async (s) => fakeUsage(s, { costUsd: 1_000_000 }),
    })
    fakes.setBudgetPolicy('{not valid json')
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-daily-malformed' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('a fleet with supportsUsage:false everywhere computes 0 daily spend without crashing or fabricating a cost', async () => {
    const fakes = makeFakes({
      withScheduler: true,
      // Simulates grok/kilo/antigravity: readSessionUsage's real dispatch
      // would give exists:false too for these, so computeDailySpendUsd's
      // `!usage.exists` guard already skips them — this proves that path
      // doesn't crash and never invents a number.
      getSessionUsage: async (s) =>
        fakeUsage(s, { exists: false, turns: 0, costUsd: 0, supportsUsage: false }),
    })
    fakes.setBudgetPolicy({ enabled: true, dailyUsdCap: 1, perSessionUsdCap: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.repoList.push(makeRepo())
    const service = createAgentSpawnService(fakes.deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-daily-unsupported' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })

  it('sessions created on a prior day do not count toward the daily total', async () => {
    const nowMs = Date.now()
    const yesterdayMs = nowMs - 25 * 60 * 60 * 1000
    const fakes = makeFakes({
      withScheduler: true,
      getSessionUsage: async (s) => fakeUsage(s, { costUsd: s.id === 'old-session' ? 1000 : 0 }),
    })
    fakes.setBudgetPolicy({ enabled: true, dailyUsdCap: 10, perSessionUsdCap: 0 })
    fakes.sessionStore.upsert(makeSession({ id: 'parent-1' }))
    fakes.sessionStore.upsert(makeSession({ id: 'old-session', createdAt: yesterdayMs }))
    fakes.repoList.push(makeRepo())
    const deps: AgentSpawnDeps = { ...fakes.deps, now: () => nowMs }
    const service = createAgentSpawnService(deps)

    const res = await emitAndWaitForResponse(
      fakes,
      'parent-1',
      newAgentReq({ id: 'req-daily-prior-day' }),
    )

    expect(res.ok).toBe(true)
    service.dispose()
  })
})
