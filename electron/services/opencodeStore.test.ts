import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import { opencodeDbPath, kiloDbPath, readOpencodeMessagesFromStore } from './opencodeStore.js'
import { opencodeMessagesToChat } from './opencodeSessions.js'

/** Build a temp opencode.db with the message/part schema this module reads,
 *  so tests never touch the real per-machine store. */
function makeTestDb(): { db: Database.Database; dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-store-'))
  const file = path.join(dir, 'opencode.db')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `)
  return { db, dir, file }
}

function insertMessage(
  db: Database.Database,
  row: { id: string; sessionId: string; timeCreated: number; data: unknown },
) {
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.sessionId, row.timeCreated, row.timeCreated, JSON.stringify(row.data))
}

function insertPart(
  db: Database.Database,
  row: { id: string; messageId: string; sessionId: string; timeCreated: number; data: unknown },
) {
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.messageId,
    row.sessionId,
    row.timeCreated,
    row.timeCreated,
    JSON.stringify(row.data),
  )
}

function insertRawPart(
  db: Database.Database,
  row: { id: string; messageId: string; sessionId: string; timeCreated: number; data: string },
) {
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.messageId, row.sessionId, row.timeCreated, row.timeCreated, row.data)
}

describe('opencodeDbPath', () => {
  let prevXdg: string | undefined

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME
  })
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  })

  it('respects XDG_DATA_HOME', () => {
    process.env.XDG_DATA_HOME = '/xdg-home'
    expect(opencodeDbPath()).toBe(path.join('/xdg-home', 'opencode', 'opencode.db'))
  })

  it('falls back to ~/.local/share', () => {
    delete process.env.XDG_DATA_HOME
    expect(opencodeDbPath()).toBe(
      path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    )
  })
})

describe('kiloDbPath', () => {
  let prevXdg: string | undefined

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME
  })
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  })

  it('respects XDG_DATA_HOME', () => {
    process.env.XDG_DATA_HOME = '/xdg-home'
    expect(kiloDbPath()).toBe(path.join('/xdg-home', 'kilo', 'kilo.db'))
  })

  it('falls back to ~/.local/share', () => {
    delete process.env.XDG_DATA_HOME
    expect(kiloDbPath()).toBe(path.join(os.homedir(), '.local', 'share', 'kilo', 'kilo.db'))
  })

  it('is a distinct path from opencodeDbPath under the same base dir', () => {
    process.env.XDG_DATA_HOME = '/xdg-home'
    expect(kiloDbPath()).not.toBe(opencodeDbPath())
    expect(kiloDbPath()).toBe(path.join('/xdg-home', 'kilo', 'kilo.db'))
    expect(opencodeDbPath()).toBe(path.join('/xdg-home', 'opencode', 'opencode.db'))
  })
})

describe('readOpencodeMessagesFromStore', () => {
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

  it('assembles a message with its parts, ordered by time_created', () => {
    ;({ db, dir, file } = makeTestDb())
    insertMessage(db, {
      id: 'msg1',
      sessionId: 'ses_1',
      timeCreated: 1000,
      data: { role: 'assistant', time: { created: 1000 } },
    })
    insertPart(db, {
      id: 'part2',
      messageId: 'msg1',
      sessionId: 'ses_1',
      timeCreated: 2000,
      data: { type: 'text', text: 'second' },
    })
    insertPart(db, {
      id: 'part1',
      messageId: 'msg1',
      sessionId: 'ses_1',
      timeCreated: 1500,
      data: { type: 'text', text: 'first' },
    })

    const messages = readOpencodeMessagesFromStore('ses_1', file)

    expect(messages).toHaveLength(1)
    expect(messages[0].info).toMatchObject({ id: 'msg1', role: 'assistant' })
    expect(messages[0].parts).toHaveLength(2)
    expect(messages[0].parts?.[0]).toMatchObject({ text: 'first' })
    expect(messages[0].parts?.[1]).toMatchObject({ text: 'second' })
  })

  it('returns [] when the db file does not exist', () => {
    const missing = path.join(os.tmpdir(), 'nonexistent-opencode-store', 'opencode.db')
    ;({ db, dir } = makeTestDb()) // for afterEach cleanup only; unused otherwise
    const messages = readOpencodeMessagesFromStore('ses_1', missing)
    expect(messages).toEqual([])
  })

  it('returns [] when the db has no rows for the given session_id', () => {
    ;({ db, dir, file } = makeTestDb())
    insertMessage(db, {
      id: 'msg1',
      sessionId: 'ses_other',
      timeCreated: 1000,
      data: { role: 'user' },
    })

    const messages = readOpencodeMessagesFromStore('ses_1', file)
    expect(messages).toEqual([])
  })

  it('skips a message row with malformed JSON rather than throwing', () => {
    ;({ db, dir, file } = makeTestDb())
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('badmsg', 'ses_1', 1000, 1000, '{not valid json')
    insertMessage(db, {
      id: 'goodmsg',
      sessionId: 'ses_1',
      timeCreated: 2000,
      data: { role: 'user' },
    })

    const messages = readOpencodeMessagesFromStore('ses_1', file)
    expect(messages).toHaveLength(1)
    expect(messages[0].info?.id).toBe('goodmsg')
  })

  it('skips a part row with malformed JSON but keeps the rest of the message', () => {
    ;({ db, dir, file } = makeTestDb())
    insertMessage(db, {
      id: 'msg1',
      sessionId: 'ses_1',
      timeCreated: 1000,
      data: { role: 'assistant' },
    })
    insertRawPart(db, {
      id: 'badpart',
      messageId: 'msg1',
      sessionId: 'ses_1',
      timeCreated: 1000,
      data: 'not json at all',
    })
    insertPart(db, {
      id: 'goodpart',
      messageId: 'msg1',
      sessionId: 'ses_1',
      timeCreated: 1500,
      data: { type: 'text', text: 'ok' },
    })

    const messages = readOpencodeMessagesFromStore('ses_1', file)
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toHaveLength(1)
    expect(messages[0].parts?.[0]).toMatchObject({ text: 'ok' })
  })

  it('maps multiple messages with multiple parts each via the real opencodeMessagesToChat', () => {
    ;({ db, dir, file } = makeTestDb())
    insertMessage(db, {
      id: 'u1',
      sessionId: 'ses_1',
      timeCreated: 1000,
      data: { role: 'user', time: { created: 1000 } },
    })
    insertPart(db, {
      id: 'p1',
      messageId: 'u1',
      sessionId: 'ses_1',
      timeCreated: 1000,
      data: { type: 'text', text: 'Begin implementing T-1.' },
    })

    insertMessage(db, {
      id: 'a1',
      sessionId: 'ses_1',
      timeCreated: 2000,
      data: { role: 'assistant', time: { created: 2000 } },
    })
    insertPart(db, {
      id: 'p2',
      messageId: 'a1',
      sessionId: 'ses_1',
      timeCreated: 2000,
      data: { type: 'text', text: 'On it.' },
    })
    insertPart(db, {
      id: 'p3',
      messageId: 'a1',
      sessionId: 'ses_1',
      timeCreated: 2100,
      data: {
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'completed', input: { cmd: 'ls' }, output: 'file.txt' },
      },
    })

    const raw = readOpencodeMessagesFromStore('ses_1', file)
    const chat = opencodeMessagesToChat(raw)

    expect(chat).toHaveLength(2)
    expect(chat[0]).toMatchObject({ uuid: 'u1', role: 'user' })
    expect(chat[1]).toMatchObject({ uuid: 'a1', role: 'assistant' })
    expect(chat[1].blocks).toEqual([
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolUseId: 'call_1', content: 'file.txt' },
    ])
  })
})
