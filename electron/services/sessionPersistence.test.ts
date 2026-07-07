import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createSessionPersistence } from './sessionPersistence.js'
import type {
  IOutcomeStore,
  ISessionManager,
  ISessionStore,
  SessionDTO,
  SessionOutcomeDTO,
} from '../shared/contract.js'

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

function makeFakes() {
  const emitter = new EventEmitter()
  const sessions = {
    on: (e: string, l: (...a: unknown[]) => void) => {
      emitter.on(e, l)
    },
    off: (e: string, l: (...a: unknown[]) => void) => {
      emitter.removeListener(e, l)
    },
  } as unknown as Pick<ISessionManager, 'on' | 'off'>

  const map = new Map<string, SessionDTO>()
  const upsert = vi.fn((s: SessionDTO) => {
    map.set(s.id, s)
  })
  const store: ISessionStore = {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    upsert,
    delete: (id) => {
      map.delete(id)
    },
  }

  const outcomeMap = new Map<string, SessionOutcomeDTO>()
  const outcomeUpsert = vi.fn((o: SessionOutcomeDTO) => {
    outcomeMap.set(o.sessionId, o)
  })
  const outcomes: IOutcomeStore = {
    get: (id) => outcomeMap.get(id),
    upsert: outcomeUpsert,
    list: () => Array.from(outcomeMap.values()),
    delete: (id) => {
      outcomeMap.delete(id)
    },
  }

  return { emitter, sessions, store, map, upsert, outcomes, outcomeMap, outcomeUpsert }
}

describe('createSessionPersistence', () => {
  it('persists a status change when no client is attached', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession({ status: 'running' }))
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('status', 's1', 'done')

    expect(store.get('s1')?.status).toBe('done')
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('persists a pr.json sentinel URL with no client attached', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession())
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('pr', 's1', 'https://example.com/pr/1')

    expect(store.get('s1')?.prUrl).toBe('https://example.com/pr/1')
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('persists the reaped status (no reaper regression)', () => {
    const { emitter, sessions, store, map, outcomes } = makeFakes()
    map.set('s1', makeSession({ status: 'running' }))
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('status', 's1', 'reaped')

    expect(store.get('s1')?.status).toBe('reaped')
  })

  it('ignores status events for sessions not yet in the store', () => {
    const { emitter, sessions, store, upsert, outcomes } = makeFakes()
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('status', 's1', 'running')

    expect(upsert).not.toHaveBeenCalled()
  })

  it('skips redundant writes when the status is unchanged', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession({ status: 'running' }))
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('status', 's1', 'running')

    expect(upsert).not.toHaveBeenCalled()
  })

  it('writes exactly once for a status transition even with repeated identical emits', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession({ status: 'running' }))
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('status', 's1', 'done')
    emitter.emit('status', 's1', 'done')

    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('skips redundant pr writes when the url is unchanged', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession({ prUrl: 'https://example.com/pr/1' }))
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('pr', 's1', 'https://example.com/pr/1')

    expect(upsert).not.toHaveBeenCalled()
  })

  it('persists exactly once even when multiple clients also listen for the same status', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession({ status: 'running' }))
    createSessionPersistence({ sessions, store, outcomes })

    // Simulate two connected clients whose per-RPC listeners push to transport.
    const clientA = vi.fn()
    const clientB = vi.fn()
    emitter.on('status', clientA)
    emitter.on('status', clientB)

    emitter.emit('status', 's1', 'done')

    expect(clientA).toHaveBeenCalledTimes(1)
    expect(clientB).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(store.get('s1')?.status).toBe('done')
  })

  it('stops persisting after dispose()', () => {
    const { emitter, sessions, store, map, upsert, outcomes } = makeFakes()
    map.set('s1', makeSession({ status: 'running' }))
    const persistence = createSessionPersistence({ sessions, store, outcomes })

    persistence.dispose()
    emitter.emit('status', 's1', 'done')

    expect(upsert).not.toHaveBeenCalled()
  })

  it('persists a structured outcome when no client is attached', () => {
    const { emitter, sessions, store, outcomes, outcomeUpsert } = makeFakes()
    createSessionPersistence({ sessions, store, outcomes })

    const outcome: SessionOutcomeDTO = {
      sessionId: 's1',
      result: 'success',
      summary: 'Fixed the bug',
      reportedAt: 1000,
    }
    emitter.emit('outcome', 's1', outcome)

    expect(outcomes.get('s1')).toEqual(outcome)
    expect(outcomeUpsert).toHaveBeenCalledTimes(1)
  })

  it('upserts an outcome unconditionally — last write wins', () => {
    const { emitter, sessions, store, outcomes, outcomeUpsert } = makeFakes()
    createSessionPersistence({ sessions, store, outcomes })

    emitter.emit('outcome', 's1', {
      sessionId: 's1',
      result: 'partial',
      summary: 'First attempt',
      reportedAt: 1000,
    } satisfies SessionOutcomeDTO)
    emitter.emit('outcome', 's1', {
      sessionId: 's1',
      result: 'success',
      summary: 'Second attempt',
      reportedAt: 2000,
    } satisfies SessionOutcomeDTO)

    expect(outcomeUpsert).toHaveBeenCalledTimes(2)
    expect(outcomes.get('s1')?.summary).toBe('Second attempt')
  })

  it('stops persisting outcomes after dispose()', () => {
    const { emitter, sessions, store, outcomes, outcomeUpsert } = makeFakes()
    const persistence = createSessionPersistence({ sessions, store, outcomes })

    persistence.dispose()
    emitter.emit('outcome', 's1', {
      sessionId: 's1',
      result: 'success',
      summary: 'Done',
      reportedAt: 1000,
    } satisfies SessionOutcomeDTO)

    expect(outcomeUpsert).not.toHaveBeenCalled()
  })
})
