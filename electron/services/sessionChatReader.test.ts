import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function makeDeps(overrides: { getOpencodeState?: ISessionManager['getOpencodeState'] } = {}) {
  const repo = makeRepo()
  return {
    repos: { resolvePath: vi.fn().mockResolvedValue(repo) } as Pick<IRepoRegistry, 'resolvePath'>,
    worktrees: {
      pathFor: vi.fn((r: RepoDTO, _branch: string) => r.path),
    } as Pick<IWorktreeManager, 'pathFor'>,
    sessions: {
      getOpencodeState: overrides.getOpencodeState,
    } as Pick<ISessionManager, 'getOpencodeState'>,
  }
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
  let tmp: string

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

  it('returns available:false for opencode with no captured port/sid', async () => {
    const { available, messages } = await readSessionChat(
      makeDeps({ getOpencodeState: () => undefined }),
      makeSession({ agentKind: 'opencode' }),
    )
    expect(available).toBe(false)
    expect(messages).toEqual([])
    expect(fetchOpencodeMessages).not.toHaveBeenCalled()
  })

  it('returns available:false for terminal-only backends (antigravity/grok)', async () => {
    for (const kind of ['antigravity', 'grok'] as const) {
      const { available, messages } = await readSessionChat(
        makeDeps(),
        makeSession({ agentKind: kind }),
      )
      expect(available).toBe(false)
      expect(messages).toEqual([])
    }
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
})
