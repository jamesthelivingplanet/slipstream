import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { ISessionStore, SessionDTO } from '../shared/contract.js'
import { restoreInterruptedSessions, createSessionStore } from './sessionStore.js'
import { runMigrations } from '../db/migrations.js'

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

// ── createSessionStore against a real (migrated) DB (TASK-CIOEQ) ────────────
// Real better-sqlite3, not a fake: this exercises the actual SQL round trip,
// which is exactly what a hand-typed fake would paper over — `mode` is
// persisted by createSessionStore.upsert via a statement separate from
// db.ts's upsertSession (see sessionStore.ts's comment), so a fake db that
// merely records calls wouldn't catch it being dropped.
describe('createSessionStore — mode persistence (TASK-CIOEQ)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRealStore(): ISessionStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
    dirs.push(dir)
    const db = new Database(path.join(dir, 'test.db'))
    runMigrations(db)
    return createSessionStore(db)
  }

  function makeSession(id: string, overrides: Partial<SessionDTO> = {}): SessionDTO {
    return {
      id,
      tid: 'CHAT-1',
      title: 'Chat Jul 30, 3:45 PM',
      prompt: '',
      repoId: 'repo1',
      branch: 'main',
      status: 'running',
      createdAt: 0,
      ...overrides,
    }
  }

  it('persists mode: "chat" and reads it back via get()', () => {
    const store = makeRealStore()
    store.upsert(makeSession('s1', { mode: 'chat' }))

    expect(store.get('s1')?.mode).toBe('chat')
  })

  it('persists mode: "chat" and reads it back via list()', () => {
    const store = makeRealStore()
    store.upsert(makeSession('s1', { mode: 'chat' }))

    expect(store.list().find((s) => s.id === 's1')?.mode).toBe('chat')
  })

  it('leaves mode unset for the default ticket-backed flow (reads back null from SQL NULL)', () => {
    const store = makeRealStore()
    store.upsert(makeSession('s2'))

    expect(store.get('s2')?.mode).toBeFalsy()
  })

  it('survives a re-open of the same DB file (daemon-restart round trip)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
    dirs.push(dir)
    const file = path.join(dir, 'test.db')

    const db1 = new Database(file)
    runMigrations(db1)
    createSessionStore(db1).upsert(makeSession('s3', { mode: 'chat' }))
    db1.close()

    const db2 = new Database(file)
    runMigrations(db2)
    expect(createSessionStore(db2).get('s3')?.mode).toBe('chat')
  })

  it('clears mode back to null on a re-upsert of the same row without it', () => {
    const store = makeRealStore()
    store.upsert(makeSession('s4', { mode: 'chat' }))
    expect(store.get('s4')?.mode).toBe('chat')

    store.upsert(makeSession('s4', { mode: undefined }))
    expect(store.get('s4')?.mode).toBeFalsy()
  })
})
