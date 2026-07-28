import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import { grokDbPath, readGrokMessagesFromStore, selectNewestGrokSessionId } from './grokStore.js'

/** Build a temp grok.db with the workspaces/sessions/messages schema this
 *  module reads, so tests never touch the real per-machine store. */
function makeTestDb(): { db: Database.Database; dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-store-'))
  const file = path.join(dir, 'grok.db')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      scope_key TEXT,
      canonical_path TEXT,
      git_root TEXT,
      display_name TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      model TEXT,
      mode TEXT,
      cwd_at_start TEXT,
      cwd_last TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE messages (
      session_id TEXT,
      seq INTEGER,
      role TEXT,
      message_json TEXT,
      created_at TEXT,
      PRIMARY KEY (session_id, seq)
    );
  `)
  return { db, dir, file }
}

function insertWorkspace(
  db: Database.Database,
  row: { id: string; canonicalPath?: string | null; gitRoot?: string | null },
) {
  db.prepare(
    'INSERT INTO workspaces (id, scope_key, canonical_path, git_root, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.id,
    row.canonicalPath ?? null,
    row.gitRoot ?? null,
    row.id,
    '2026-07-19T00:00:00.000Z',
  )
}

function insertSession(
  db: Database.Database,
  row: { id: string; workspaceId: string; createdAt: string; updatedAt?: string | null },
) {
  db.prepare(
    'INSERT INTO sessions (id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.workspaceId,
    'title',
    'model',
    'mode',
    '/',
    '/',
    'idle',
    row.createdAt,
    row.updatedAt ?? null,
  )
}

function insertMessage(
  db: Database.Database,
  row: { sessionId: string; seq: number; message: unknown; createdAt: string },
) {
  db.prepare(
    'INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    row.sessionId,
    row.seq,
    (row.message as Record<string, unknown>)['role'],
    JSON.stringify(row.message),
    row.createdAt,
  )
}

describe('grokDbPath', () => {
  it('defaults to ~/.grok/grok.db', () => {
    expect(grokDbPath()).toBe(path.join(os.homedir(), '.grok', 'grok.db'))
  })
})

describe('selectNewestGrokSessionId', () => {
  let dir: string
  let db: Database.Database

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('matches by canonical_path and picks the newest session by updated_at', () => {
    ;({ db, dir } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/repo/wt' })
    insertSession(db, {
      id: 'older',
      workspaceId: 'ws1',
      createdAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:05:00.000Z',
    })
    insertSession(db, {
      id: 'newer',
      workspaceId: 'ws1',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:05:00.000Z',
    })

    expect(selectNewestGrokSessionId(db, '/repo/wt')).toBe('newer')
  })

  it('falls back to git_root when no canonical_path matches', () => {
    ;({ db, dir } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/somewhere/else', gitRoot: '/repo/wt' })
    insertSession(db, { id: 'only', workspaceId: 'ws1', createdAt: '2026-07-19T10:00:00.000Z' })

    expect(selectNewestGrokSessionId(db, '/repo/wt')).toBe('only')
  })

  it('falls back to created_at when updated_at is null', () => {
    ;({ db, dir } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/repo/wt' })
    insertSession(db, { id: 'older', workspaceId: 'ws1', createdAt: '2026-07-18T10:00:00.000Z' })
    insertSession(db, { id: 'newer', workspaceId: 'ws1', createdAt: '2026-07-19T10:00:00.000Z' })

    expect(selectNewestGrokSessionId(db, '/repo/wt')).toBe('newer')
  })

  it('returns null when no workspace matches', () => {
    ;({ db, dir } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/other/path' })
    insertSession(db, { id: 's1', workspaceId: 'ws1', createdAt: '2026-07-19T10:00:00.000Z' })

    expect(selectNewestGrokSessionId(db, '/repo/wt')).toBeNull()
  })

  it('returns null when the workspace has no sessions', () => {
    ;({ db, dir } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/repo/wt' })

    expect(selectNewestGrokSessionId(db, '/repo/wt')).toBeNull()
  })
})

describe('readGrokMessagesFromStore', () => {
  let dir: string
  let file: string
  let db: Database.Database

  afterEach(() => {
    try {
      db.close()
    } catch {
      // already closed by the reader
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads the newest session for the worktree, ordered by seq', () => {
    ;({ db, dir, file } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/repo/wt' })
    insertSession(db, { id: 'older', workspaceId: 'ws1', createdAt: '2026-07-18T10:00:00.000Z' })
    insertSession(db, { id: 'newer', workspaceId: 'ws1', createdAt: '2026-07-19T10:00:00.000Z' })

    insertMessage(db, {
      sessionId: 'older',
      seq: 0,
      message: { role: 'user', content: 'ignore me' },
      createdAt: '2026-07-18T10:00:00.000Z',
    })
    insertMessage(db, {
      sessionId: 'newer',
      seq: 1,
      message: { role: 'assistant', content: 'second' },
      createdAt: '2026-07-19T10:01:00.000Z',
    })
    insertMessage(db, {
      sessionId: 'newer',
      seq: 0,
      message: { role: 'user', content: 'first' },
      createdAt: '2026-07-19T10:00:00.000Z',
    })

    const messages = readGrokMessagesFromStore('/repo/wt', file)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ uuid: 'newer:0', role: 'user' })
    expect(messages[1]).toMatchObject({ uuid: 'newer:1', role: 'assistant' })
  })

  it('returns [] when the db file does not exist', () => {
    const missing = path.join(os.tmpdir(), 'nonexistent-grok-store', 'grok.db')
    ;({ db, dir } = makeTestDb()) // for afterEach cleanup only; unused otherwise
    expect(readGrokMessagesFromStore('/repo/wt', missing)).toEqual([])
  })

  it('returns [] when no workspace matches the worktree', () => {
    ;({ db, dir, file } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/other/path' })
    insertSession(db, { id: 's1', workspaceId: 'ws1', createdAt: '2026-07-19T10:00:00.000Z' })
    insertMessage(db, {
      sessionId: 's1',
      seq: 0,
      message: { role: 'user', content: 'hi' },
      createdAt: '2026-07-19T10:00:00.000Z',
    })

    expect(readGrokMessagesFromStore('/repo/wt', file)).toEqual([])
  })

  it('skips a message row with malformed JSON rather than throwing', () => {
    ;({ db, dir, file } = makeTestDb())
    insertWorkspace(db, { id: 'ws1', canonicalPath: '/repo/wt' })
    insertSession(db, { id: 's1', workspaceId: 'ws1', createdAt: '2026-07-19T10:00:00.000Z' })
    db.prepare(
      'INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('s1', 0, 'user', '{not valid json', '2026-07-19T10:00:00.000Z')
    insertMessage(db, {
      sessionId: 's1',
      seq: 1,
      message: { role: 'user', content: 'ok' },
      createdAt: '2026-07-19T10:00:01.000Z',
    })

    const messages = readGrokMessagesFromStore('/repo/wt', file)
    expect(messages).toHaveLength(1)
    expect(messages[0].uuid).toBe('s1:1')
  })
})
