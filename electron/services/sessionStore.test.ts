import { describe, it, expect } from 'vitest'
import type { ISessionStore, SessionDTO } from '../shared/contract.js'
import { restoreInterruptedSessions } from './sessionStore.js'

function makeStore(initial: SessionDTO[]): ISessionStore & { upsertCount: number } {
  const map = new Map<string, SessionDTO>(initial.map((s) => [s.id, s]))
  let upsertCount = 0
  return {
    get upsertCount() {
      return upsertCount
    },
    list() {
      return [...map.values()]
    },
    get(id) {
      return map.get(id)
    },
    upsert(s) {
      map.set(s.id, s)
      upsertCount++
    },
    delete(id) {
      map.delete(id)
    },
  }
}

function makeSession(id: string, status: SessionDTO['status']): SessionDTO {
  return {
    id,
    tid: 'T-1',
    title: 'test',
    prompt: 'do it',
    repoId: 'repo1',
    branch: 'main',
    status,
    createdAt: 0,
  }
}

describe('restoreInterruptedSessions', () => {
  it('marks running sessions as interrupted', () => {
    const store = makeStore([makeSession('s1', 'running')])
    const result = restoreInterruptedSessions(store)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('interrupted')
    expect(store.get('s1')?.status).toBe('interrupted')
  })

  it('marks needs sessions as interrupted', () => {
    const store = makeStore([makeSession('s2', 'needs')])
    const result = restoreInterruptedSessions(store)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('interrupted')
  })

  it('leaves done sessions unchanged', () => {
    const store = makeStore([makeSession('s3', 'done')])
    const result = restoreInterruptedSessions(store)
    expect(result).toHaveLength(0)
    expect(store.upsertCount).toBe(0)
    expect(store.get('s3')?.status).toBe('done')
  })

  it('leaves errored sessions unchanged', () => {
    const store = makeStore([makeSession('s4', 'errored')])
    const result = restoreInterruptedSessions(store)
    expect(result).toHaveLength(0)
    expect(store.upsertCount).toBe(0)
  })

  it('leaves idle sessions unchanged', () => {
    const store = makeStore([makeSession('s5', 'idle')])
    const result = restoreInterruptedSessions(store)
    expect(result).toHaveLength(0)
    expect(store.upsertCount).toBe(0)
  })

  it('leaves already-interrupted sessions unchanged', () => {
    const store = makeStore([makeSession('s6', 'interrupted')])
    const result = restoreInterruptedSessions(store)
    expect(result).toHaveLength(0)
    expect(store.upsertCount).toBe(0)
  })

  it('returns only changed sessions when mixed statuses', () => {
    const store = makeStore([
      makeSession('a', 'running'),
      makeSession('b', 'done'),
      makeSession('c', 'needs'),
      makeSession('d', 'idle'),
    ])
    const result = restoreInterruptedSessions(store)
    expect(result.map((s) => s.id).sort()).toEqual(['a', 'c'])
    expect(store.upsertCount).toBe(2)
  })
})
