import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import { createAgentSpawnService } from './agentSpawnService.js'
import type { AgentSpawnDeps, AgentSpawnScheduler } from './agentSpawnService.js'
import type { LaunchDeps, LaunchRequest } from './sessionLauncher.js'
import type { AgentResponse } from './agentRequestSentinel.js'
import type {
  AgentRequest,
  ISessionManager,
  ISessionStore,
  IOutcomeStore,
  IRepoRegistry,
  RepoDTO,
  SessionDTO,
  SessionOutcomeDTO,
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
  deps: AgentSpawnDeps
}

function makeFakes(opts: { withScheduler?: boolean } = {}): Fakes {
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
    tickets: {
      startTicket: async () => null,
    },
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

  const deps: AgentSpawnDeps = {
    sessions,
    sessionStore,
    repos,
    outcomeStore,
    launchDeps,
    scheduler,
    dataDir: '/data',
    writeResponse,
  }

  return { emitter, sessionStore, repoList, outcomeMap, responses, scheduler, deps }
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
