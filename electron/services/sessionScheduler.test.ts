import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSessionScheduler,
  readSchedulerPolicy,
  writeSchedulerPolicy,
} from './sessionScheduler.js'
import type { SchedulerDeps } from './sessionScheduler.js'
import type {
  ISessionManager,
  ISessionStore,
  LiveSessionInfo,
  SchedulerPolicy,
  SessionDTO,
  SessionEvents,
} from '../shared/contract.js'
import { DEFAULT_SCHEDULER_POLICY } from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import type { RunLogger } from './runLogger.js'
import type { LaunchRequest } from './sessionLauncher.js'

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

function makeReq(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    sessionId: 's1',
    tid: 'T-1',
    title: 'Fix bug',
    prompt: 'fix it',
    repoId: 'r1',
    branch: 'b1',
    systemPrompt: 'system',
    ownerId: 'local',
    ...overrides,
  }
}

function makeSessionDto(id: string, overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id,
    tid: 'T-1',
    title: 'Fix bug',
    prompt: 'fix it',
    repoId: 'r1',
    branch: 'b1',
    status: 'running',
    createdAt: 0,
    ...overrides,
  }
}

type Listener = (...args: unknown[]) => void

function makeSessionsFake(initial: LiveSessionInfo[] = []): Pick<
  ISessionManager,
  'liveSessions' | 'on' | 'off'
> & {
  live: LiveSessionInfo[]
  emit: <E extends keyof SessionEvents>(event: E, ...args: Parameters<SessionEvents[E]>) => void
} {
  const listeners: Record<string, Listener[]> = {}
  const state = { live: [...initial] }
  return {
    get live() {
      return state.live
    },
    set live(v) {
      state.live = v
    },
    liveSessions: vi.fn(() => state.live),
    on(event: string, listener: Listener) {
      listeners[event] ??= []
      listeners[event].push(listener)
    },
    off(event: string, listener: Listener) {
      if (listeners[event]) listeners[event] = listeners[event].filter((l) => l !== listener)
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args)
    },
  } as unknown as Pick<ISessionManager, 'liveSessions' | 'on' | 'off'> & {
    live: LiveSessionInfo[]
    emit: <E extends keyof SessionEvents>(event: E, ...args: Parameters<SessionEvents[E]>) => void
  }
}

describe('readSchedulerPolicy / writeSchedulerPolicy', () => {
  let config: IConfigStore

  beforeEach(() => {
    config = makeConfig()
  })

  it('returns the default policy when nothing is stored', () => {
    expect(readSchedulerPolicy(config)).toEqual(DEFAULT_SCHEDULER_POLICY)
  })

  it('round-trips a written policy', () => {
    const policy: SchedulerPolicy = { maxConcurrent: 3 }
    writeSchedulerPolicy(config, policy)
    expect(readSchedulerPolicy(config)).toEqual(policy)
  })

  it('falls back to defaults on malformed JSON', () => {
    config.set('scheduler.policy', '{not json')
    expect(readSchedulerPolicy(config)).toEqual(DEFAULT_SCHEDULER_POLICY)
  })

  it('clamps a negative maxConcurrent to 0', () => {
    config.set('scheduler.policy', JSON.stringify({ maxConcurrent: -5 }))
    expect(readSchedulerPolicy(config)).toEqual({ maxConcurrent: 0 })
  })

  it('floors a non-integer maxConcurrent', () => {
    config.set('scheduler.policy', JSON.stringify({ maxConcurrent: 2.7 }))
    expect(readSchedulerPolicy(config)).toEqual({ maxConcurrent: 2 })
  })

  it('defaults a non-numeric maxConcurrent', () => {
    config.set('scheduler.policy', JSON.stringify({ maxConcurrent: 'nope' }))
    expect(readSchedulerPolicy(config)).toEqual(DEFAULT_SCHEDULER_POLICY)
  })
})

describe('createSessionScheduler', () => {
  let config: IConfigStore
  let store: ISessionStore
  let logger: RunLogger

  function deps(
    sessionsFake: ReturnType<typeof makeSessionsFake>,
    launch: (req: LaunchRequest) => Promise<SessionDTO>,
    extra: Partial<SchedulerDeps> = {},
  ): SchedulerDeps {
    return {
      sessions: sessionsFake,
      store,
      config,
      launch,
      logger,
      now: () => 1000,
      ...extra,
    }
  }

  beforeEach(() => {
    config = makeConfig()
    store = makeStore()
    logger = { spawn: vi.fn(), exit: vi.fn(), server: vi.fn() }
  })

  it('maxConcurrent 0 (unlimited) always launches immediately, nothing queued', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 0 })
    const sessionsFake = makeSessionsFake()
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s1', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))

    const result = await scheduler.submit(makeReq())
    expect(launch).toHaveBeenCalledOnce()
    expect(result.status).toBe('running')
    expect(scheduler.queuedIds()).toEqual([])
  })

  it('under cap launches immediately', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 2 })
    const sessionsFake = makeSessionsFake([])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s1'))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))

    const result = await scheduler.submit(makeReq())
    expect(launch).toHaveBeenCalledOnce()
    expect(result.status).toBe('running')
  })

  it('over cap returns a queued DTO, persists the row, and enqueues FIFO', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2'))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))

    const r1 = await scheduler.submit(makeReq({ sessionId: 's2' }))
    expect(r1.status).toBe('queued')
    expect(launch).not.toHaveBeenCalled()
    expect(store.get('s2')?.status).toBe('queued')

    const r2 = await scheduler.submit(makeReq({ sessionId: 's3' }))
    expect(r2.status).toBe('queued')
    expect(scheduler.queuedIds()).toEqual(['s2', 's3'])
  })

  it('in-flight launches count toward the cap (two quick submits, cap 1, slow launch)', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([])
    let resolveLaunch!: (dto: SessionDTO) => void
    const launch = vi.fn().mockImplementation(
      () =>
        new Promise<SessionDTO>((resolve) => {
          resolveLaunch = resolve
        }),
    )
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))

    const p1 = scheduler.submit(makeReq({ sessionId: 's1' }))
    // second submit happens before the first launch resolves — liveSessions()
    // is still empty, so only the inFlight counter can prevent double-launch
    const r2 = await scheduler.submit(makeReq({ sessionId: 's2' }))
    expect(r2.status).toBe('queued')
    expect(launch).toHaveBeenCalledOnce()

    resolveLaunch(makeSessionDto('s1', { status: 'running' }))
    const r1 = await p1
    expect(r1.status).toBe('running')
  })

  it('drain on exit event launches the next queued entry', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    expect(launch).not.toHaveBeenCalled()

    // The live session exits, freeing a slot.
    sessionsFake.live = []
    sessionsFake.emit('exit', 'live1', 0)
    await new Promise((r) => setTimeout(r, 0))

    expect(launch).toHaveBeenCalledOnce()
    expect(scheduler.queuedIds()).toEqual([])
    scheduler.stop()
  })

  it('drain on status "reaped" launches the next queued entry', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    sessionsFake.live = []
    sessionsFake.emit('status', 'live1', 'reaped')
    await new Promise((r) => setTimeout(r, 0))

    expect(launch).toHaveBeenCalledOnce()
    scheduler.stop()
  })

  // Regression: sessionManager emits 'exit' / status 'reaped' BEFORE deleting
  // the dying session from its internal map, so the scheduler's listeners run
  // while liveSessions() still contains the dead session. A synchronous drain
  // inside that emit would see zero capacity and stall the queue forever —
  // the scheduler must defer the drain past the emitting function (it uses
  // queueMicrotask). These tests mirror that exact ordering: the listener is
  // invoked with the session still live, and it's only removed after the
  // listener returns.
  it('drains even though the exit event fires before liveSessions() drops the dead session (real sessionManager ordering)', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    expect(launch).not.toHaveBeenCalled()

    // Mirror sessionManager.onExit: emit('status') → emit('exit') → map delete.
    // Listeners run with 'live1' STILL in liveSessions(); it is only removed
    // after they return.
    sessionsFake.emit('status', 'live1', 'errored')
    sessionsFake.emit('exit', 'live1', 0)
    sessionsFake.live = []

    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    expect(scheduler.queuedIds()).toEqual([])
    scheduler.stop()
  })

  it('drains even though the reaped status fires before liveSessions() drops the dead session (real reap() ordering)', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))

    // Mirror sessionManager.reap(): emit('status','reaped') → pty.kill → map delete.
    sessionsFake.emit('status', 'live1', 'reaped')
    sessionsFake.live = []

    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    scheduler.stop()
  })

  it('a flapping status event (running/needs) does NOT trigger launches beyond capacity', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    // Still live (not reaped) — capacity is exhausted regardless.
    sessionsFake.emit('status', 'live1', 'running')
    sessionsFake.emit('status', 'live1', 'needs')
    sessionsFake.emit('status', 'live1', 'running')
    await new Promise((r) => setTimeout(r, 0))

    expect(launch).not.toHaveBeenCalled()
    expect(scheduler.queuedIds()).toEqual(['s2'])
    scheduler.stop()
  })

  it('cancel removes a queued entry and returns true; false when absent', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2'))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    await scheduler.submit(makeReq({ sessionId: 's2' }))
    expect(scheduler.queuedIds()).toEqual(['s2'])

    expect(scheduler.cancel('s2')).toBe(true)
    expect(scheduler.queuedIds()).toEqual([])
    expect(scheduler.cancel('s2')).toBe(false)
  })

  it('stale rows (deleted from the store) are skipped by drain without launching', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    store.delete('s2') // simulate cleanupSession deleting the row
    sessionsFake.live = []
    sessionsFake.emit('exit', 'live1', 0)
    await new Promise((r) => setTimeout(r, 0))

    expect(launch).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('stale rows (status changed off queued) are skipped by drain', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    const launch = vi.fn().mockResolvedValue(makeSessionDto('s2', { status: 'running' }))
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    const row = store.get('s2')!
    store.upsert({ ...row, status: 'interrupted' }) // simulate killSession cancel path
    sessionsFake.live = []
    sessionsFake.emit('exit', 'live1', 0)
    await new Promise((r) => setTimeout(r, 0))

    expect(launch).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('launch failure marks the row errored and the next entry still launches', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 1 })
    const sessionsFake = makeSessionsFake([
      { id: 'live1', status: 'running', createdAt: 0, lastActivityAt: 0 },
    ])
    // Mimics real launchSession's contract: on success it persists the
    // 'running' row itself (the scheduler only writes 'errored' on failure).
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async (req: LaunchRequest) => {
        const dto = makeSessionDto(req.sessionId, { status: 'running' })
        store.upsert(dto)
        return dto
      })
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()

    await scheduler.submit(makeReq({ sessionId: 's2' }))
    await scheduler.submit(makeReq({ sessionId: 's3' }))
    expect(scheduler.queuedIds()).toEqual(['s2', 's3'])

    sessionsFake.live = []
    sessionsFake.emit('exit', 'live1', 0)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(store.get('s2')?.status).toBe('errored')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(store.get('s3')?.status).toBe('running')
    scheduler.stop()
  })

  it('start() restores persisted queued rows oldest-first and drains', async () => {
    writeSchedulerPolicy(config, { maxConcurrent: 5 })
    store.upsert(makeSessionDto('older', { status: 'queued', createdAt: 100 }))
    store.upsert(makeSessionDto('newer', { status: 'queued', createdAt: 200 }))
    store.upsert(makeSessionDto('done1', { status: 'done', createdAt: 50 })) // not queued, ignored

    const sessionsFake = makeSessionsFake([])
    const launched: string[] = []
    const launch = vi.fn().mockImplementation(async (req: LaunchRequest) => {
      launched.push(req.sessionId)
      return makeSessionDto(req.sessionId, { status: 'running' })
    })
    const scheduler = createSessionScheduler(deps(sessionsFake, launch))
    scheduler.start()
    await new Promise((r) => setTimeout(r, 0))

    expect(launched).toEqual(['older', 'newer'])
    scheduler.stop()
  })
})
