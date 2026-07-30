import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSessionReaper,
  readGcPolicy,
  writeGcPolicy,
  readBudgetPolicy,
  writeBudgetPolicy,
} from './sessionReaper.js'
import type { ReaperDeps } from './sessionReaper.js'
import type {
  BudgetPolicy,
  GcPolicy,
  ISessionManager,
  ISessionStore,
  LiveSessionInfo,
  SessionDTO,
  SessionUsage,
} from '../shared/contract.js'
import { DEFAULT_BUDGET_POLICY, DEFAULT_GC_POLICY } from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import type { RunLogger } from './runLogger.js'

function makeConfig(): IConfigStore {
  const map = new Map<string, string>()
  return {
    get(key) {
      return map.get(key)
    },
    set(key, value) {
      map.set(key, value)
    },
  }
}

function makeSession(overrides: Partial<LiveSessionInfo> = {}): LiveSessionInfo {
  return { id: 's1', status: 'running', createdAt: 0, lastActivityAt: 0, ...overrides }
}

function makeStore(): ISessionStore {
  const map = new Map<string, SessionDTO>()
  return {
    list() {
      return Array.from(map.values())
    },
    get(id) {
      return map.get(id)
    },
    upsert(s) {
      map.set(s.id, s)
    },
    delete(id) {
      map.delete(id)
    },
  }
}

function makeSessionDto(id: string): SessionDTO {
  return {
    id,
    tid: 'T-1',
    title: 'title',
    prompt: 'prompt',
    repoId: 'r1',
    branch: 'b1',
    status: 'running',
    createdAt: 0,
  }
}

function makeSessionsFake(
  initial: LiveSessionInfo[] = [],
): Pick<ISessionManager, 'liveSessions' | 'reap'> & { reaped: string[] } {
  let live = [...initial]
  const reaped: string[] = []
  return {
    reaped,
    liveSessions: vi.fn(() => live),
    reap: vi.fn((id: string) => {
      reaped.push(id)
      live = live.filter((s) => s.id !== id)
    }),
  }
}

describe('readGcPolicy / writeGcPolicy', () => {
  let config: IConfigStore

  beforeEach(() => {
    config = makeConfig()
  })

  it('returns the default policy when nothing is stored', () => {
    expect(readGcPolicy(config)).toEqual(DEFAULT_GC_POLICY)
  })

  it('round-trips a written policy', () => {
    const policy: GcPolicy = {
      enabled: false,
      onlyAbandoned: false,
      autoStopOnDone: false,
      idleMs: 5000,
      maxAgeMs: 60000,
    }
    writeGcPolicy(config, policy)
    expect(readGcPolicy(config)).toEqual(policy)
  })

  it('falls back to defaults on malformed JSON', () => {
    config.set('gc.policy', '{not json')
    expect(readGcPolicy(config)).toEqual(DEFAULT_GC_POLICY)
  })

  it('coerces invalid/partial fields to defaults, field by field', () => {
    config.set(
      'gc.policy',
      JSON.stringify({ enabled: false, idleMs: -5, maxAgeMs: 'nope', onlyAbandoned: 'yes' }),
    )
    expect(readGcPolicy(config)).toEqual({
      ...DEFAULT_GC_POLICY,
      enabled: false,
    })
  })
})

describe('createSessionReaper', () => {
  let config: IConfigStore
  let store: ISessionStore
  let viewersMap: Map<string, number>
  let logger: RunLogger

  function deps(
    sessionsFake: ReturnType<typeof makeSessionsFake>,
    now: () => number,
    extra: Partial<ReaperDeps> = {},
  ): ReaperDeps {
    return {
      sessions: sessionsFake,
      store,
      config,
      viewers: (id) => viewersMap.get(id) ?? 0,
      logger,
      now,
      ...extra,
    }
  }

  beforeEach(() => {
    config = makeConfig()
    store = makeStore()
    viewersMap = new Map()
    logger = { spawn: vi.fn(), exit: vi.fn(), server: vi.fn(), deleteSessionLog: vi.fn() }
  })

  it('reaps nothing when disabled', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, enabled: false })
    const sessionsFake = makeSessionsFake([makeSession({ status: 'done' })])
    const reaper = createSessionReaper(deps(sessionsFake, () => 0))
    expect(await reaper.tick()).toEqual([])
    expect(sessionsFake.reap).not.toHaveBeenCalled()
  })

  it('autoStopOnDone reaps a live done session with 0 viewers', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, onlyAbandoned: true, autoStopOnDone: true })
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1', status: 'done' })])
    const reaper = createSessionReaper(deps(sessionsFake, () => 0))
    expect(await reaper.tick()).toEqual(['s1'])
  })

  it('does not reap a done session with viewers when onlyAbandoned is true', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, onlyAbandoned: true, autoStopOnDone: true })
    viewersMap.set('s1', 1)
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1', status: 'done' })])
    const reaper = createSessionReaper(deps(sessionsFake, () => 0))
    expect(await reaper.tick()).toEqual([])
  })

  it('reaps a done session with viewers when onlyAbandoned is false', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, onlyAbandoned: false, autoStopOnDone: true })
    viewersMap.set('s1', 1)
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1', status: 'done' })])
    const reaper = createSessionReaper(deps(sessionsFake, () => 0))
    expect(await reaper.tick()).toEqual(['s1'])
  })

  it('reaps a session idle longer than idleMs', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, autoStopOnDone: false, idleMs: 1000 })
    const sessionsFake = makeSessionsFake([
      makeSession({ id: 's1', status: 'running', lastActivityAt: 0 }),
    ])
    const reaper = createSessionReaper(deps(sessionsFake, () => 1000))
    expect(await reaper.tick()).toEqual(['s1'])
  })

  it('does not reap a session idle within idleMs', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, autoStopOnDone: false, idleMs: 1000 })
    const sessionsFake = makeSessionsFake([
      makeSession({ id: 's1', status: 'running', lastActivityAt: 500 }),
    ])
    const reaper = createSessionReaper(deps(sessionsFake, () => 1000))
    expect(await reaper.tick()).toEqual([])
  })

  it('idleMs 0 disables idle reaping', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, autoStopOnDone: false, idleMs: 0 })
    const sessionsFake = makeSessionsFake([
      makeSession({ id: 's1', status: 'running', lastActivityAt: 0 }),
    ])
    const reaper = createSessionReaper(deps(sessionsFake, () => 1_000_000))
    expect(await reaper.tick()).toEqual([])
  })

  it('reaps a session older than maxAgeMs', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, autoStopOnDone: false, maxAgeMs: 1000 })
    const sessionsFake = makeSessionsFake([
      makeSession({ id: 's1', status: 'running', createdAt: 0, lastActivityAt: 0 }),
    ])
    const reaper = createSessionReaper(deps(sessionsFake, () => 1000))
    expect(await reaper.tick()).toEqual(['s1'])
  })

  it('maxAgeMs 0 disables age reaping', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, autoStopOnDone: false, maxAgeMs: 0 })
    const sessionsFake = makeSessionsFake([
      makeSession({ id: 's1', status: 'running', createdAt: 0, lastActivityAt: 0 }),
    ])
    const reaper = createSessionReaper(deps(sessionsFake, () => 1_000_000))
    expect(await reaper.tick()).toEqual([])
  })

  it('persists status "reaped" to the store and logs the reap', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, onlyAbandoned: false, autoStopOnDone: true })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1', status: 'done' })])
    const reaper = createSessionReaper(deps(sessionsFake, () => 0))

    await reaper.tick()

    expect(store.get('s1')?.status).toBe('reaped')
    expect(logger.server).toHaveBeenCalledWith(
      'info',
      'session reaped',
      expect.objectContaining({ sessionId: 's1', prevStatus: 'done' }),
    )
  })

  it('tick returns the ids of every reaped session', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, onlyAbandoned: false, autoStopOnDone: true })
    const sessionsFake = makeSessionsFake([
      makeSession({ id: 's1', status: 'done' }),
      makeSession({ id: 's2', status: 'running' }),
      makeSession({ id: 's3', status: 'done' }),
    ])
    const reaper = createSessionReaper(deps(sessionsFake, () => 0))
    expect((await reaper.tick()).sort()).toEqual(['s1', 's3'])
  })
})

describe('readBudgetPolicy / writeBudgetPolicy', () => {
  let config: IConfigStore

  beforeEach(() => {
    config = makeConfig()
  })

  it('returns the default policy when nothing is stored', () => {
    expect(readBudgetPolicy(config)).toEqual(DEFAULT_BUDGET_POLICY)
  })

  it('round-trips a written policy', () => {
    const policy: BudgetPolicy = { dailyUsdCap: 25, perSessionUsdCap: 5, enabled: true }
    writeBudgetPolicy(config, policy)
    expect(readBudgetPolicy(config)).toEqual(policy)
  })

  it('round-trips fractional USD caps without flooring (unlike GcPolicy ms fields)', () => {
    const policy: BudgetPolicy = { dailyUsdCap: 10.25, perSessionUsdCap: 3.5, enabled: true }
    writeBudgetPolicy(config, policy)
    expect(readBudgetPolicy(config)).toEqual(policy)
  })

  it('falls back to defaults on malformed JSON', () => {
    config.set('budget.policy', '{not json')
    expect(readBudgetPolicy(config)).toEqual(DEFAULT_BUDGET_POLICY)
  })

  it('coerces invalid/partial fields to defaults, field by field', () => {
    config.set(
      'budget.policy',
      JSON.stringify({ enabled: true, dailyUsdCap: 'nope', perSessionUsdCap: -5 }),
    )
    expect(readBudgetPolicy(config)).toEqual({
      ...DEFAULT_BUDGET_POLICY,
      enabled: true,
      // perSessionUsdCap: -5 clamps to 0 (Math.max(0, n)), not to the default.
      perSessionUsdCap: 0,
    })
  })
})

describe('createSessionReaper — budget cap', () => {
  let config: IConfigStore
  let store: ISessionStore
  let viewersMap: Map<string, number>
  let logger: RunLogger

  function fakeUsage(
    overrides: Partial<SessionUsage & { supportsUsage: boolean }> = {},
  ): SessionUsage & { supportsUsage: boolean } {
    return {
      sessionId: 's1',
      exists: true,
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      costUsd: 0,
      turns: 1,
      supportsUsage: true,
      ...overrides,
    }
  }

  function deps(
    sessionsFake: ReturnType<typeof makeSessionsFake>,
    now: () => number,
    extra: Partial<ReaperDeps> = {},
  ): ReaperDeps {
    return {
      sessions: sessionsFake,
      store,
      config,
      viewers: (id) => viewersMap.get(id) ?? 0,
      logger,
      now,
      ...extra,
    }
  }

  beforeEach(() => {
    config = makeConfig()
    store = makeStore()
    viewersMap = new Map()
    logger = { spawn: vi.fn(), exit: vi.fn(), server: vi.fn(), deleteSessionLog: vi.fn() }
  })

  it('does not reap a session under the per-session cap', async () => {
    writeBudgetPolicy(config, { enabled: true, dailyUsdCap: 0, perSessionUsdCap: 5 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 1 }),
      }),
    )
    expect(await reaper.tick()).toEqual([])
  })

  it('reaps a session at/over the per-session cap, with a reason mentioning budget', async () => {
    writeBudgetPolicy(config, { enabled: true, dailyUsdCap: 0, perSessionUsdCap: 5 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 5 }),
      }),
    )
    expect(await reaper.tick()).toEqual(['s1'])
    expect(logger.server).toHaveBeenCalledWith(
      'info',
      'session reaped',
      expect.objectContaining({ sessionId: 's1', reason: expect.stringContaining('budget') }),
    )
  })

  it('perSessionUsdCap: 0 means unlimited — never reaps on cost grounds', async () => {
    writeBudgetPolicy(config, { enabled: true, dailyUsdCap: 0, perSessionUsdCap: 0 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 1_000_000 }),
      }),
    )
    expect(await reaper.tick()).toEqual([])
  })

  it('budgetPolicy.enabled: false disables budget reaping even with cost over the cap', async () => {
    writeBudgetPolicy(config, { enabled: false, dailyUsdCap: 0, perSessionUsdCap: 1 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 100 }),
      }),
    )
    expect(await reaper.tick()).toEqual([])
  })

  it('GC disabled + budget enabled: budget reaping still works independently', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, enabled: false })
    writeBudgetPolicy(config, { enabled: true, dailyUsdCap: 0, perSessionUsdCap: 1 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1', status: 'running' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 100 }),
      }),
    )
    expect(await reaper.tick()).toEqual(['s1'])
  })

  it('budget disabled + GC enabled: GC reaping still works independently', async () => {
    writeGcPolicy(config, { ...DEFAULT_GC_POLICY, onlyAbandoned: false, autoStopOnDone: true })
    writeBudgetPolicy(config, { enabled: false, dailyUsdCap: 0, perSessionUsdCap: 1 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1', status: 'done' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 100 }),
      }),
    )
    expect(await reaper.tick()).toEqual(['s1'])
  })

  it('never reaps a session with supportsUsage:false, even with an artificially high cost', async () => {
    writeBudgetPolicy(config, { enabled: true, dailyUsdCap: 0, perSessionUsdCap: 1 })
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 1_000_000, supportsUsage: false }),
      }),
    )
    expect(await reaper.tick()).toEqual([])
  })

  it('a malformed stored budget.policy coerces to defaults — no budget enforcement', async () => {
    config.set('budget.policy', '{not json')
    store.upsert(makeSessionDto('s1'))
    const sessionsFake = makeSessionsFake([makeSession({ id: 's1' })])
    const reaper = createSessionReaper(
      deps(sessionsFake, () => 0, {
        getSessionUsage: async () => fakeUsage({ costUsd: 1_000_000 }),
      }),
    )
    expect(await reaper.tick()).toEqual([])
  })
})
