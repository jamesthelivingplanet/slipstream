import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import {
  antigravityConversationsDir,
  antigravityDbPathFor,
  listAntigravityConversationIds,
  readAntigravityMessagesFromDb,
  readNewestAntigravityConversation,
} from './antigravityStore.js'

// Minimal hand-built protobuf encoders, just enough to build a step_type=14
// (user message) payload for fixture rows — same approach as
// antigravityChatMessages.test.ts / protoWalk.test.ts.
function encodeVarint(n: number): Buffer {
  let v = n
  const bytes: number[] = []
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    bytes.push(b)
  } while (v > 0)
  return Buffer.from(bytes)
}

function tag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType)
}

function lenField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 2), encodeVarint(payload.length), payload])
}

function textField(fieldNumber: number, text: string): Buffer {
  return lenField(fieldNumber, Buffer.from(text, 'utf8'))
}

/** A step_type=14 (user message) payload carrying `text` at .19.2. */
function userMessagePayload(text: string): Buffer {
  return lenField(19, textField(2, text))
}

/** Build a temp conversations dir with a `steps`-schema SQLite db, so tests
 *  never touch the real per-machine `~/.gemini` store. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-store-'))
}

function makeConversationDb(dir: string, conversationId: string): Database.Database {
  const file = path.join(dir, `${conversationId}.db`)
  const db = new Database(file)
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER,
      step_type INTEGER,
      status INTEGER,
      metadata BLOB,
      error_details BLOB,
      permissions BLOB,
      task_details BLOB,
      render_info BLOB,
      step_payload BLOB,
      step_format INTEGER
    );
  `)
  return db
}

function insertStep(
  db: Database.Database,
  row: { idx: number; step_type: number; step_payload: Buffer | null },
) {
  db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
    row.idx,
    row.step_type,
    row.step_payload,
  )
}

describe('antigravityConversationsDir', () => {
  it('defaults to ~/.gemini/antigravity-cli/conversations', () => {
    expect(antigravityConversationsDir()).toBe(
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations'),
    )
  })
})

describe('antigravityDbPathFor', () => {
  it('joins the conversation id with a .db extension under the given dir', () => {
    expect(antigravityDbPathFor('abc-123', '/some/dir')).toBe(path.join('/some/dir', 'abc-123.db'))
  })

  it('defaults to antigravityConversationsDir() when no dir is given', () => {
    expect(antigravityDbPathFor('abc-123')).toBe(
      path.join(antigravityConversationsDir(), 'abc-123.db'),
    )
  })
})

describe('listAntigravityConversationIds', () => {
  let dir: string

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns [] when the directory does not exist', () => {
    dir = path.join(os.tmpdir(), 'antigravity-store-nonexistent-' + Date.now())
    expect(listAntigravityConversationIds(dir)).toEqual([])
  })

  it('returns [] for an empty directory', () => {
    dir = makeTempDir()
    expect(listAntigravityConversationIds(dir)).toEqual([])
  })

  it('lists .db files as conversation ids, ignoring non-.db files', () => {
    dir = makeTempDir()
    fs.writeFileSync(path.join(dir, 'conv-1.db'), '')
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a db')
    const ids = listAntigravityConversationIds(dir)
    expect(ids).toEqual(['conv-1'])
  })

  it('orders multiple conversations newest-first by mtime', () => {
    dir = makeTempDir()
    const older = path.join(dir, 'older.db')
    const newer = path.join(dir, 'newer.db')
    fs.writeFileSync(older, '')
    fs.writeFileSync(newer, '')
    const past = new Date(Date.now() - 60_000)
    const now = new Date()
    fs.utimesSync(older, past, past)
    fs.utimesSync(newer, now, now)

    expect(listAntigravityConversationIds(dir)).toEqual(['newer', 'older'])
  })
})

describe('readAntigravityMessagesFromDb', () => {
  let dir: string
  let db: Database.Database

  afterEach(() => {
    try {
      db.close()
    } catch {
      // already closed by the reader
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads steps ordered by idx ASC and maps them via the antigravity mapper', () => {
    dir = makeTempDir()
    db = makeConversationDb(dir, 'conv-1')
    insertStep(db, { idx: 1, step_type: 14, step_payload: userMessagePayload('second') })
    insertStep(db, { idx: 0, step_type: 14, step_payload: userMessagePayload('first') })

    const messages = readAntigravityMessagesFromDb('conv-1', antigravityDbPathFor('conv-1', dir))

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      uuid: 'conv-1:0',
      role: 'user',
      blocks: [{ type: 'text', text: 'first' }],
    })
    expect(messages[1]).toMatchObject({
      uuid: 'conv-1:1',
      role: 'user',
      blocks: [{ type: 'text', text: 'second' }],
    })
  })

  it('returns [] when the db file does not exist', () => {
    dir = makeTempDir()
    db = makeConversationDb(dir, 'placeholder') // for afterEach cleanup only
    const missing = path.join(dir, 'nonexistent.db')
    expect(readAntigravityMessagesFromDb('nonexistent', missing)).toEqual([])
  })

  it('returns [] when the steps table is missing (unexpected schema)', () => {
    dir = makeTempDir()
    const file = path.join(dir, 'no-steps-table.db')
    db = new Database(file)
    db.exec('CREATE TABLE something_else (id INTEGER);')
    expect(readAntigravityMessagesFromDb('no-steps-table', file)).toEqual([])
  })

  it('never throws and skips rows with malformed/truncated step_payload', () => {
    dir = makeTempDir()
    db = makeConversationDb(dir, 'conv-2')
    insertStep(db, { idx: 0, step_type: 14, step_payload: Buffer.from([0x80, 0xff, 0x02]) })
    insertStep(db, { idx: 1, step_type: 14, step_payload: userMessagePayload('ok') })

    let messages: ReturnType<typeof readAntigravityMessagesFromDb> = []
    expect(() => {
      messages = readAntigravityMessagesFromDb('conv-2', antigravityDbPathFor('conv-2', dir))
    }).not.toThrow()
    expect(messages.map((m) => m.uuid)).toEqual(['conv-2:1'])
  })

  it('defaults dbPath to antigravityDbPathFor(conversationId) when not given', () => {
    // Exercises the default-parameter path without touching the real
    // ~/.gemini store: a conversation id that certainly has no real db
    // resolves to [] rather than throwing.
    expect(readAntigravityMessagesFromDb('definitely-not-a-real-conversation-id')).toEqual([])
  })
})

describe('readNewestAntigravityConversation', () => {
  let dir: string
  let db: Database.Database

  afterEach(() => {
    try {
      db.close()
    } catch {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when there are no conversation dbs', () => {
    dir = makeTempDir()
    expect(readNewestAntigravityConversation(dir)).toBeNull()
  })

  it('reads the most-recently-modified conversation', () => {
    dir = makeTempDir()
    const olderDb = makeConversationDb(dir, 'older')
    insertStep(olderDb, { idx: 0, step_type: 14, step_payload: userMessagePayload('old convo') })
    olderDb.close()

    db = makeConversationDb(dir, 'newer')
    insertStep(db, { idx: 0, step_type: 14, step_payload: userMessagePayload('new convo') })

    const past = new Date(Date.now() - 60_000)
    const now = new Date()
    fs.utimesSync(path.join(dir, 'older.db'), past, past)
    fs.utimesSync(path.join(dir, 'newer.db'), now, now)

    const result = readNewestAntigravityConversation(dir)
    expect(result?.conversationId).toBe('newer')
    expect(result?.messages).toMatchObject([{ blocks: [{ type: 'text', text: 'new convo' }] }])
  })
})
