import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import { readSessionChat } from './sessionChatReader.js'
import type {
  IRepoRegistry,
  ISessionManager,
  IWorktreeManager,
  RepoDTO,
  SessionDTO,
} from '../shared/contract.js'
import { piSessionDirFor } from './piSessions.js'

// Mock only the network call; keep the real opencode→chat mapper so the
// reader's opencode branch is exercised end-to-end against a real shape.
vi.mock('./opencodeSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opencodeSessions.js')>()
  return { ...actual, fetchOpencodeMessages: vi.fn() }
})
const { fetchOpencodeMessages } = await import('./opencodeSessions.js')

// Set by the describe block's beforeEach before each test runs; module-scoped
// (rather than declared inside the describe) so makeDeps() below can default
// opencodeDbPath into it.
let tmp: string

function makeRepo(): RepoDTO {
  return { id: 'r1', org: 'acme', name: 'api', base: 'main', path: '/repos/api' }
}

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

function makeDeps(
  overrides: {
    getOpencodeState?: ISessionManager['getOpencodeState']
    opencodeDbPath?: string
    grokDbPath?: string
  } = {},
) {
  const repo = makeRepo()
  return {
    repos: { resolvePath: vi.fn().mockResolvedValue(repo) } as Pick<IRepoRegistry, 'resolvePath'>,
    worktrees: {
      pathFor: vi.fn((r: RepoDTO, _branch: string) => r.path),
    } as Pick<IWorktreeManager, 'pathFor'>,
    sessions: {
      getOpencodeState: overrides.getOpencodeState,
    } as Pick<ISessionManager, 'getOpencodeState'>,
    // Always point at a path under the test's temp dir rather than falling
    // through to the real per-machine opencode.db default — a nonexistent
    // path here degrades to [] (opencodeStore.ts is best-effort), so tests
    // that don't care about the durable-store fallback still get a clean
    // available:false without risking a hit on the actual machine's store.
    opencodeDbPath: overrides.opencodeDbPath ?? path.join(tmp, 'opencode-unused.db'),
    // Same idea for grok's durable store — default to a nonexistent path
    // under tmp so tests that don't care get a clean available:false without
    // risking a hit on the real machine's ~/.grok/grok.db.
    grokDbPath: overrides.grokDbPath ?? path.join(tmp, 'grok-unused.db'),
  }
}

/** Build a minimal opencode.db fixture (message/part tables) at `file` with
 *  one user + one assistant message for `sessionId`, mirroring the shapes
 *  documented in opencodeStore.ts. */
function makeOpencodeDbFixture(file: string, sessionId: string) {
  const db = new Database(file)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `)
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  ).run('u1', sessionId, 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }))
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'p1',
    'u1',
    sessionId,
    1000,
    1000,
    JSON.stringify({ type: 'text', text: 'Begin implementing T-1 (from durable store).' }),
  )
  db.close()
}

/** Build a minimal grok.db fixture (workspaces/sessions/messages tables) at
 *  `file`, with one workspace at `worktreePath`, one session under it, and a
 *  user + assistant message pair for `sessionId`, mirroring the shapes
 *  documented in grokStore.ts/grokChatMessages.ts. */
function makeGrokDbFixture(file: string, sessionId: string, worktreePath: string) {
  const db = new Database(file)
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, canonical_path TEXT, git_root TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT, updated_at TEXT, created_at TEXT
    );
    CREATE TABLE messages (
      session_id TEXT, seq INTEGER, role TEXT, message_json TEXT, created_at TEXT
    );
  `)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO workspaces (id, canonical_path, git_root) VALUES (?, ?, ?)').run(
    'w1',
    worktreePath,
    worktreePath,
  )
  db.prepare(
    'INSERT INTO sessions (id, workspace_id, updated_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, 'w1', now, now)
  db.prepare(
    'INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    sessionId,
    1,
    'user',
    JSON.stringify({ role: 'user', content: 'Begin implementing T-1 (from grok store).' }),
    now,
  )
  db.prepare(
    'INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    sessionId,
    2,
    'assistant',
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'On it.' }] }),
    now,
  )
  db.close()
}

const claudeTranscript = [
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'Begin implementing T-1.' },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2024-01-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Investigating the codebase.' }],
    },
  }),
].join('\n')

describe('readSessionChat', () => {
  let prevConfigDir: string | undefined
  let prevPiDir: string | undefined

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-chat-'))
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    prevPiDir = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmp, 'pi')
    vi.mocked(fetchOpencodeMessages).mockReset()
  })

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevPiDir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reads claude-code transcript lines into chat messages', async () => {
    fs.mkdirSync(path.join(tmp, 'claude', 'projects', 'any'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'claude', 'projects', 'any', 's1.jsonl'),
      claudeTranscript,
      'utf8',
    )

    const { available, messages } = await readSessionChat(makeDeps(), makeSession())

    expect(available).toBe(true)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[1]).toMatchObject({ role: 'assistant' })
  })

  it('returns available:false when no claude-code transcript exists', async () => {
    const { available, messages } = await readSessionChat(makeDeps(), makeSession())
    expect(available).toBe(false)
    expect(messages).toEqual([])
  })

  it('merges subagent transcripts, ordered by ts, threading the root turn via meta.json toolUseId, and stamps sidechainId + meta fields on EVERY message', async () => {
    fs.mkdirSync(path.join(tmp, 'claude', 'projects', 'any'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'claude', 'projects', 'any', 's1.jsonl'),
      claudeTranscript,
      'utf8',
    )
    const subagentsDir = path.join(tmp, 'claude', 'projects', 'any', 's1', 'subagents')
    fs.mkdirSync(subagentsDir, { recursive: true })
    const subagentTranscript = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        agentId: 'agentA',
        type: 'user',
        uuid: 'sub-u1',
        // Between the two main-transcript messages, so ordering across the
        // merge (not just within one source) is exercised.
        timestamp: '2024-01-01T00:00:00.500Z',
        message: { role: 'user', content: 'You are implementing a focused bug fix...' },
      }),
      JSON.stringify({
        parentUuid: 'sub-u1',
        isSidechain: true,
        agentId: 'agentA',
        type: 'assistant',
        uuid: 'sub-a1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
    ].join('\n')
    fs.writeFileSync(path.join(subagentsDir, 'agent-agentA.jsonl'), subagentTranscript, 'utf8')
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-agentA.meta.json'),
      JSON.stringify({
        toolUseId: 'toolu_parent_call',
        description: 'Fix the bug',
        agentType: 'general-purpose',
      }),
      'utf8',
    )

    const { available, messages } = await readSessionChat(makeDeps(), makeSession())

    expect(available).toBe(true)
    expect(messages).toHaveLength(4)
    // ts-ordered across both sources: main u1, sub-u1, main a1, sub-a1.
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'sub-u1', 'a1', 'sub-a1'])
    const subRoot = messages.find((m) => m.uuid === 'sub-u1')
    expect(subRoot).toMatchObject({
      isSidechain: true,
      parentUuid: 'toolu_parent_call',
      sidechainId: 'agentA',
      sidechainToolUseId: 'toolu_parent_call',
      sidechainDescription: 'Fix the bug',
      sidechainAgentType: 'general-purpose',
    })
    const subReply = messages.find((m) => m.uuid === 'sub-a1')
    // Non-root sidechain line keeps its own internal parentUuid chain, not
    // the toolUseId — only the chain's first line gets threaded to the call.
    // But sidechainId/meta fields are stamped on it too, not just the root.
    expect(subReply).toMatchObject({
      isSidechain: true,
      parentUuid: 'sub-u1',
      sidechainId: 'agentA',
      sidechainToolUseId: 'toolu_parent_call',
      sidechainDescription: 'Fix the bug',
      sidechainAgentType: 'general-purpose',
    })
    // Main-transcript messages are untouched — no sidechain fields at all.
    const mainMsg = messages.find((m) => m.uuid === 'u1')
    expect(mainMsg?.sidechainId).toBeUndefined()
  })

  it('stamps sidechainId on every subagent message even with no meta.json (no sidechainToolUseId)', async () => {
    fs.mkdirSync(path.join(tmp, 'claude', 'projects', 'any'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'claude', 'projects', 'any', 's1.jsonl'),
      claudeTranscript,
      'utf8',
    )
    const subagentsDir = path.join(tmp, 'claude', 'projects', 'any', 's1', 'subagents')
    fs.mkdirSync(subagentsDir, { recursive: true })
    const subagentTranscript = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        type: 'user',
        uuid: 'sub-u1',
        timestamp: '2024-01-01T00:00:00.500Z',
        message: { role: 'user', content: 'delegate' },
      }),
      JSON.stringify({
        parentUuid: 'sub-u1',
        isSidechain: true,
        type: 'assistant',
        uuid: 'sub-a1',
        timestamp: '2024-01-01T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
    ].join('\n')
    // No sibling agent-agentNoMeta.meta.json written at all.
    fs.writeFileSync(path.join(subagentsDir, 'agent-agentNoMeta.jsonl'), subagentTranscript, 'utf8')

    const { messages } = await readSessionChat(makeDeps(), makeSession())

    const sub = messages.filter((m) => m.isSidechain)
    expect(sub).toHaveLength(2)
    for (const m of sub) {
      expect(m.sidechainId).toBe('agentNoMeta')
      expect(m.sidechainToolUseId).toBeUndefined()
      expect(m.sidechainDescription).toBeUndefined()
      expect(m.sidechainAgentType).toBeUndefined()
    }
  })

  it('returns just the main transcript when the session has no subagents dir', async () => {
    fs.mkdirSync(path.join(tmp, 'claude', 'projects', 'any'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'claude', 'projects', 'any', 's1.jsonl'),
      claudeTranscript,
      'utf8',
    )

    const { available, messages } = await readSessionChat(makeDeps(), makeSession())

    expect(available).toBe(true)
    expect(messages).toHaveLength(2)
  })

  it('still returns the main transcript when a subagent file is malformed/unreadable', async () => {
    fs.mkdirSync(path.join(tmp, 'claude', 'projects', 'any'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'claude', 'projects', 'any', 's1.jsonl'),
      claudeTranscript,
      'utf8',
    )
    const subagentsDir = path.join(tmp, 'claude', 'projects', 'any', 's1', 'subagents')
    fs.mkdirSync(subagentsDir, { recursive: true })
    // Malformed JSON — should be skipped, not thrown.
    fs.writeFileSync(path.join(subagentsDir, 'agent-bad.jsonl'), 'not json\n{{{', 'utf8')
    // Unreadable: a directory instead of a file at the expected jsonl path.
    fs.mkdirSync(path.join(subagentsDir, 'agent-dir.jsonl'))

    const { available, messages } = await readSessionChat(makeDeps(), makeSession())

    expect(available).toBe(true)
    expect(messages).toHaveLength(2)
  })

  it('reads pi session files (cwd-scoped)', async () => {
    const cwd = '/repos/api'
    const dir = piSessionDirFor(cwd)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          id: 'u1',
          timestamp: '2024-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'fix the bug' },
        }),
        JSON.stringify({
          type: 'message',
          id: 'a1',
          timestamp: '2024-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'On it.' }],
          },
        }),
      ].join('\n'),
      'utf8',
    )

    const { available, messages } = await readSessionChat(
      makeDeps(),
      makeSession({ agentKind: 'pi' }),
    )

    expect(available).toBe(true)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[1]).toMatchObject({ role: 'assistant' })
  })

  it('returns available:false for pi when no session file exists', async () => {
    const { available, messages } = await readSessionChat(
      makeDeps(),
      makeSession({ agentKind: 'pi' }),
    )
    expect(available).toBe(false)
    expect(messages).toEqual([])
  })

  it('reads opencode messages from the embedded server state', async () => {
    vi.mocked(fetchOpencodeMessages).mockResolvedValue([
      // Minimal shape opencodeMessageToChat accepts — a user text message.
      {
        info: { id: 'msg1', role: 'user', time: { created: 0 } },
        parts: [{ type: 'text', text: 'Begin implementing T-1.' }],
      },
    ])
    const deps = makeDeps({
      getOpencodeState: () => ({ port: 4321, sid: 'ses_1' }),
    })

    const { available, messages } = await readSessionChat(
      deps,
      makeSession({ agentKind: 'opencode' }),
    )

    expect(available).toBe(true)
    expect(fetchOpencodeMessages).toHaveBeenCalledWith(4321, 'ses_1')
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0]).toMatchObject({ role: 'user' })
  })

  it('falls back to the durable SQLite store when no live port/sid but session.opencodeSid resolves messages', async () => {
    const dbFile = path.join(tmp, 'opencode.db')
    makeOpencodeDbFixture(dbFile, 'ses_durable')
    const deps = makeDeps({ getOpencodeState: () => undefined, opencodeDbPath: dbFile })

    const { available, messages } = await readSessionChat(
      deps,
      makeSession({ agentKind: 'opencode', opencodeSid: 'ses_durable' }),
    )

    expect(available).toBe(true)
    expect(fetchOpencodeMessages).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user' })
  })

  it('returns available:false for opencode with no captured port/sid', async () => {
    const { available, messages } = await readSessionChat(
      makeDeps({ getOpencodeState: () => undefined }),
      makeSession({ agentKind: 'opencode' }),
    )
    expect(available).toBe(false)
    expect(messages).toEqual([])
    expect(fetchOpencodeMessages).not.toHaveBeenCalled()
  })

  it('returns available:false when neither live state nor the durable store (nonexistent db) has anything', async () => {
    const deps = makeDeps({
      getOpencodeState: () => undefined,
      opencodeDbPath: path.join(tmp, 'does-not-exist', 'opencode.db'),
    })

    const { available, messages } = await readSessionChat(
      deps,
      makeSession({ agentKind: 'opencode', opencodeSid: 'ses_missing' }),
    )

    expect(available).toBe(false)
    expect(messages).toEqual([])
    expect(fetchOpencodeMessages).not.toHaveBeenCalled()
  })

  it('returns available:false for terminal-only backends (antigravity)', async () => {
    for (const kind of ['antigravity'] as const) {
      const { available, messages } = await readSessionChat(
        makeDeps(),
        makeSession({ agentKind: kind }),
      )
      expect(available).toBe(false)
      expect(messages).toEqual([])
    }
  })

  it('reads grok messages from the durable SQLite store', async () => {
    const dbFile = path.join(tmp, 'grok.db')
    makeGrokDbFixture(dbFile, 'ses_grok', '/repos/api')
    const deps = makeDeps({ grokDbPath: dbFile })

    const { available, messages } = await readSessionChat(deps, makeSession({ agentKind: 'grok' }))

    expect(available).toBe(true)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[1]).toMatchObject({ role: 'assistant' })
  })

  it('returns available:false for grok when no store/session exists', async () => {
    const { available, messages } = await readSessionChat(
      makeDeps(),
      makeSession({ agentKind: 'grok' }),
    )
    expect(available).toBe(false)
    expect(messages).toEqual([])
  })

  it('does not throw when repo resolution fails (pi path)', async () => {
    const deps = {
      repos: { resolvePath: vi.fn().mockRejectedValue(new Error('boom')) },
      worktrees: { pathFor: vi.fn() },
      sessions: { getOpencodeState: undefined },
    }
    const { available, messages } = await readSessionChat(
      deps as unknown as Parameters<typeof readSessionChat>[0],
      makeSession({ agentKind: 'pi' }),
    )
    expect(available).toBe(false)
    expect(messages).toEqual([])
    expect(deps.worktrees.pathFor).not.toHaveBeenCalled()
  })

  it('does not throw when repo resolution fails (grok path)', async () => {
    const deps = {
      repos: { resolvePath: vi.fn().mockRejectedValue(new Error('boom')) },
      worktrees: { pathFor: vi.fn() },
      sessions: { getOpencodeState: undefined },
    }
    const { available, messages } = await readSessionChat(
      deps as unknown as Parameters<typeof readSessionChat>[0],
      makeSession({ agentKind: 'grok' }),
    )
    expect(available).toBe(false)
    expect(messages).toEqual([])
    expect(deps.worktrees.pathFor).not.toHaveBeenCalled()
  })
})
