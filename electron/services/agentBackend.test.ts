import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DONE_MARKER } from '../shared/promptComposer.js'
import type { StatusHandle } from './agentBackend.js'

vi.mock('./piSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./piSessions.js')>()
  return {
    ...actual,
    findNewestPiSessionFile: vi.fn(),
    readPiSessionFile: vi.fn(),
  }
})

vi.mock('./opencodeSessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opencodeSessions.js')>()
  return {
    ...actual,
    queryOpencodeSessionIdFromCli: vi.fn(),
    fetchOpencodeMessages: vi.fn(),
  }
})

const { selectBackend, claudeCodeBackend, opencodeBackend, piBackend } =
  await import('./agentBackend.js')
const { findNewestPiSessionFile, readPiSessionFile } = await import('./piSessions.js')
const { queryOpencodeSessionIdFromCli, fetchOpencodeMessages } =
  await import('./opencodeSessions.js')

describe('selectBackend', () => {
  it('returns claudeCodeBackend for "claude-code"', () => {
    expect(selectBackend('claude-code')).toBe(claudeCodeBackend)
  })

  it('returns claudeCodeBackend for undefined (default)', () => {
    expect(selectBackend(undefined)).toBe(claudeCodeBackend)
  })

  it('returns opencodeBackend for "opencode"', () => {
    expect(selectBackend('opencode')).toBe(opencodeBackend)
  })

  it('returns piBackend for "pi"', () => {
    expect(selectBackend('pi')).toBe(piBackend)
  })
})

describe('statusSource', () => {
  it('claude-code uses pty', () => {
    expect(claudeCodeBackend.statusSource).toBe('pty')
  })

  it('opencode uses poll', () => {
    expect(opencodeBackend.statusSource).toBe('poll')
  })

  it('pi uses poll', () => {
    expect(piBackend.statusSource).toBe('poll')
  })
})

describe('claudeCodeBackend.buildStartArgs', () => {
  it('cmd is "claude"', () => {
    const { cmd } = claudeCodeBackend.buildStartArgs({
      sessionId: 'abc',
      system: '',
      user: 'do task',
    })
    expect(cmd).toBe('claude')
  })

  it('args include --dangerously-skip-permissions, --session-id, sessionId, and user prompt last', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid1',
      system: '',
      user: 'my task',
    })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--session-id')
    expect(args).toContain('sid1')
    expect(args[args.length - 1]).toBe('my task')
  })

  it('with non-empty system, args include --append-system-prompt followed by system text', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid2',
      system: 'sys prompt',
      user: 'task',
    })
    const idx = args.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('sys prompt')
  })

  it('with empty system, args do NOT include --append-system-prompt', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid3',
      system: '',
      user: 'task',
    })
    expect(args).not.toContain('--append-system-prompt')
  })

  it('with empty user prompt, args do NOT include the prompt (no trailing empty string)', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid4',
      system: '',
      user: '',
    })
    expect(args).not.toContain('')
    expect(args[args.length - 1]).not.toBe('')
    // Should end with sessionId
    expect(args[args.length - 1]).toBe('sid4')
  })
})

describe('claudeCodeBackend.buildResumeArgs', () => {
  it('hasPriorSession:true → args are [--dangerously-skip-permissions, --resume, id] only', () => {
    const { cmd, args } = claudeCodeBackend.buildResumeArgs({
      sessionId: 'myid',
      system: 'sys',
      user: 'task',
      hasPriorSession: true,
    })
    expect(cmd).toBe('claude')
    expect(args).toEqual(['--dangerously-skip-permissions', '--resume', 'myid'])
  })

  it('hasPriorSession:false → uses --session-id + prompt', () => {
    const { args } = claudeCodeBackend.buildResumeArgs({
      sessionId: 'myid2',
      system: '',
      user: 'my prompt',
      hasPriorSession: false,
    })
    expect(args).toContain('--session-id')
    expect(args).toContain('myid2')
    expect(args[args.length - 1]).toBe('my prompt')
  })
})

describe('claudeCodeBackend.buildRemoteControlArgs', () => {
  it('includes --remote-control', () => {
    const { args } = claudeCodeBackend.buildRemoteControlArgs({
      sessionId: 'rcid',
      system: '',
      user: 'task',
      hasPriorSession: false,
    })
    expect(args).toContain('--remote-control')
  })

  it('hasPriorSession:true → uses --resume', () => {
    const { args } = claudeCodeBackend.buildRemoteControlArgs({
      sessionId: 'rcid2',
      system: '',
      user: 'task',
      hasPriorSession: true,
    })
    expect(args).toContain('--remote-control')
    expect(args).toContain('--resume')
    expect(args).toContain('rcid2')
  })

  it('hasPriorSession:false → uses --session-id', () => {
    const { args } = claudeCodeBackend.buildRemoteControlArgs({
      sessionId: 'rcid3',
      system: '',
      user: 'task',
      hasPriorSession: false,
    })
    expect(args).toContain('--remote-control')
    expect(args).toContain('--session-id')
    expect(args).toContain('rcid3')
  })
})

describe('claudeCodeBackend.hasPriorSession', () => {
  it('returns false when no transcript exists for the session id', () => {
    expect(
      claudeCodeBackend.hasPriorSession?.({
        sessionId: 'no-such-transcript-abc123',
        cwd: '/tmp/whatever',
      }),
    ).toBe(false)
  })
})

describe('opencodeBackend.buildStartArgs', () => {
  it('includes --prompt with user text', () => {
    const { args } = opencodeBackend.buildStartArgs({
      sessionId: 'oc1',
      system: '',
      user: 'hello task',
      opencodePort: undefined,
    })
    const idx = args.indexOf('--prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('hello task')
  })

  it('includes --port with port string when opencodePort given', () => {
    const { args } = opencodeBackend.buildStartArgs({
      sessionId: 'oc2',
      system: '',
      user: 'task',
      opencodePort: 3333,
    })
    const idx = args.indexOf('--port')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('3333')
  })

  it('omits --port when opencodePort not given', () => {
    const { args } = opencodeBackend.buildStartArgs({ sessionId: 'oc3', system: '', user: 'task' })
    expect(args).not.toContain('--port')
  })
})

describe('opencodeBackend.buildResumeArgs', () => {
  it('hasPriorSession:true + opencodeSid → includes ["--session", sid] and NO --prompt', () => {
    const { args } = opencodeBackend.buildResumeArgs({
      sessionId: 'oc4',
      system: '',
      user: 'task',
      hasPriorSession: true,
      opencodeSid: 'my-oc-sid',
    })
    expect(args).toContain('--session')
    expect(args).toContain('my-oc-sid')
    expect(args).not.toContain('--prompt')
  })

  it('hasPriorSession:true without opencodeSid → includes --continue', () => {
    const { args } = opencodeBackend.buildResumeArgs({
      sessionId: 'oc5',
      system: '',
      user: 'task',
      hasPriorSession: true,
    })
    expect(args).toContain('--continue')
  })

  it('hasPriorSession:false → falls back to a fresh start (--prompt, no --continue/--session)', () => {
    const { args } = opencodeBackend.buildResumeArgs({
      sessionId: 'oc5b',
      system: 'sys prompt',
      user: 'task',
      hasPriorSession: false,
    })
    expect(args).not.toContain('--continue')
    expect(args).not.toContain('--session')
    const idx = args.indexOf('--prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('task')
  })
})

describe('opencodeBackend.buildRemoteControlArgs', () => {
  it('behaves identically to buildResumeArgs: with sid → --session; without sid but hasPriorSession → --continue', () => {
    const withSid = opencodeBackend.buildRemoteControlArgs({
      sessionId: 'oc6',
      system: '',
      user: 'task',
      hasPriorSession: true,
      opencodeSid: 'some-sid',
    })
    expect(withSid.args).toContain('--session')
    expect(withSid.args).toContain('some-sid')

    const withoutSid = opencodeBackend.buildRemoteControlArgs({
      sessionId: 'oc7',
      system: '',
      user: 'task',
      hasPriorSession: true,
    })
    expect(withoutSid.args).toContain('--continue')
  })

  it('hasPriorSession:false → falls back to a fresh start', () => {
    const { args } = opencodeBackend.buildRemoteControlArgs({
      sessionId: 'oc8',
      system: '',
      user: 'task',
      hasPriorSession: false,
    })
    expect(args).not.toContain('--continue')
    const idx = args.indexOf('--prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
  })
})

describe('opencodeBackend.hasPriorSession', () => {
  it('true when opencodeSid is set', () => {
    expect(
      opencodeBackend.hasPriorSession?.({ sessionId: 's', cwd: '/x', opencodeSid: 'ses_1' }),
    ).toBe(true)
  })

  it('false when opencodeSid is absent', () => {
    expect(opencodeBackend.hasPriorSession?.({ sessionId: 's', cwd: '/x' })).toBe(false)
  })
})

describe('piBackend.buildStartArgs', () => {
  it('cmd ends with "pi"', () => {
    const { cmd } = piBackend.buildStartArgs({ sessionId: 'p1', system: '', user: 'task' })
    expect(cmd.endsWith('pi')).toBe(true)
  })

  it('args start with --approve and end with the user prompt', () => {
    const { args } = piBackend.buildStartArgs({ sessionId: 'p2', system: '', user: 'pi task' })
    expect(args[0]).toBe('--approve')
    expect(args[args.length - 1]).toBe('pi task')
  })

  it('with non-empty system, args include --append-system-prompt followed by system text', () => {
    const { args } = piBackend.buildStartArgs({ sessionId: 'p3', system: 'pi sys', user: 'task' })
    const idx = args.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('pi sys')
  })

  it('with empty user prompt, args do NOT include the prompt (no trailing empty string)', () => {
    const { args } = piBackend.buildStartArgs({ sessionId: 'p4', system: '', user: '' })
    expect(args).not.toContain('')
    expect(args[args.length - 1]).not.toBe('')
    // Should end with --approve (or system args if present)
    expect(args[args.length - 1]).toBe('--approve')
  })
})

describe('piBackend resume / remote-control', () => {
  it('hasPriorSession:true → buildResumeArgs is [--approve, --continue]', () => {
    const { args } = piBackend.buildResumeArgs({
      sessionId: 'p4',
      system: '',
      user: 'task',
      hasPriorSession: true,
    })
    expect(args).toEqual(['--approve', '--continue'])
  })

  it('hasPriorSession:true → buildRemoteControlArgs is [--approve, --continue]', () => {
    const { args } = piBackend.buildRemoteControlArgs({
      sessionId: 'p5',
      system: '',
      user: 'task',
      hasPriorSession: true,
    })
    expect(args).toEqual(['--approve', '--continue'])
  })

  it('hasPriorSession:false → buildResumeArgs falls back to the same spec as buildStartArgs', () => {
    const resumed = piBackend.buildResumeArgs({
      sessionId: 'p6',
      system: 'pi sys',
      user: 'task',
      hasPriorSession: false,
    })
    const started = piBackend.buildStartArgs({ sessionId: 'p6', system: 'pi sys', user: 'task' })
    expect(resumed).toEqual(started)
  })

  it('hasPriorSession:false → buildRemoteControlArgs falls back to the same spec as buildStartArgs', () => {
    const remoted = piBackend.buildRemoteControlArgs({
      sessionId: 'p7',
      system: 'pi sys',
      user: 'task',
      hasPriorSession: false,
    })
    const started = piBackend.buildStartArgs({ sessionId: 'p7', system: 'pi sys', user: 'task' })
    expect(remoted).toEqual(started)
  })
})

describe('piBackend.hasPriorSession', () => {
  let root: string
  let prevSessionDir: string | undefined
  const cwd = '/tmp/some-worktree'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slipstream-pi-hasprior-'))
    prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.PI_CODING_AGENT_SESSION_DIR = root
  })

  afterEach(() => {
    if (prevSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir
    rmSync(root, { recursive: true, force: true })
  })

  it('false when the session dir does not exist', () => {
    expect(piBackend.hasPriorSession?.({ sessionId: 's', cwd })).toBe(false)
  })

  it('true when the session dir has at least one .jsonl file', async () => {
    const { piSessionDirFor } = await import('./piSessions.js')
    const dir = piSessionDirFor(cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run1.jsonl'), '{}')
    expect(piBackend.hasPriorSession?.({ sessionId: 's', cwd })).toBe(true)
  })
})

describe('claudeCodeBackend.buildHandoffArgs', () => {
  it('hasPriorSession:false → uses --session-id + id + prompt is present', () => {
    const { cmd, args } = claudeCodeBackend.buildHandoffArgs({
      sessionId: 'hoid1',
      system: '',
      user: 'takeover prompt',
      hasPriorSession: false,
    })
    expect(cmd).toBe('claude')
    expect(args).toContain('--session-id')
    expect(args).toContain('hoid1')
    expect(args[args.length - 1]).toBe('takeover prompt')
  })

  it('hasPriorSession:true → uses --resume + id + the handoff prompt as the last arg; no --session-id', () => {
    const { args } = claudeCodeBackend.buildHandoffArgs({
      sessionId: 'hoid3',
      system: '',
      user: 'takeover prompt',
      hasPriorSession: true,
    })
    expect(args).toContain('--resume')
    expect(args).toContain('hoid3')
    expect(args).not.toContain('--session-id')
    expect(args[args.length - 1]).toBe('takeover prompt')
  })
})

describe('opencodeBackend.buildHandoffArgs', () => {
  it('includes --prompt with the handoff text', () => {
    const { args } = opencodeBackend.buildHandoffArgs({
      sessionId: 'ohid1',
      system: '',
      user: 'takeover prompt',
      hasPriorSession: false,
    })
    const idx = args.indexOf('--prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('takeover prompt')
  })

  it('includes --port with port string when opencodePort given', () => {
    const { args } = opencodeBackend.buildHandoffArgs({
      sessionId: 'ohid2',
      system: '',
      user: 'takeover prompt',
      hasPriorSession: false,
      opencodePort: 4444,
    })
    const idx = args.indexOf('--port')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('4444')
  })
})

describe('piBackend.buildHandoffArgs', () => {
  it('cmd ends with "pi"', () => {
    const { cmd } = piBackend.buildHandoffArgs({
      sessionId: 'phid1',
      system: '',
      user: 'takeover prompt',
      hasPriorSession: false,
    })
    expect(cmd.endsWith('pi')).toBe(true)
  })

  it('args contain --approve and end with the prompt', () => {
    const { args } = piBackend.buildHandoffArgs({
      sessionId: 'phid2',
      system: '',
      user: 'takeover prompt',
      hasPriorSession: false,
    })
    expect(args).toContain('--approve')
    expect(args[args.length - 1]).toBe('takeover prompt')
  })

  it('with non-empty system, includes --append-system-prompt followed by system text', () => {
    const { args } = piBackend.buildHandoffArgs({
      sessionId: 'phid3',
      system: 'pi sys',
      user: 'takeover prompt',
      hasPriorSession: false,
    })
    const idx = args.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('pi sys')
  })
})

describe('beginStatusTracking presence', () => {
  it('opencodeBackend.beginStatusTracking is a function', () => {
    expect(typeof opencodeBackend.beginStatusTracking).toBe('function')
  })

  it('piBackend.beginStatusTracking is a function', () => {
    expect(typeof piBackend.beginStatusTracking).toBe('function')
  })

  it('claudeCodeBackend.beginStatusTracking is undefined (PTY-driven)', () => {
    expect(claudeCodeBackend.beginStatusTracking).toBeUndefined()
  })
})

describe('prepareWorktree presence', () => {
  it('opencodeBackend.prepareWorktree is a function', () => {
    expect(typeof opencodeBackend.prepareWorktree).toBe('function')
  })

  it('claudeCodeBackend.prepareWorktree is undefined', () => {
    expect(claudeCodeBackend.prepareWorktree).toBeUndefined()
  })

  it('piBackend.prepareWorktree is undefined', () => {
    expect(piBackend.prepareWorktree).toBeUndefined()
  })
})

// ─── FLO-94-adjacent status-polling fallback (never freeze forever) ──────────

/** Minimal fake StatusHandle: not disposed, captures setStatus calls, and
 *  stores whatever timer runPoll registers (never advanced manually — tests
 *  drive ticks via vi's fake timers). */
function makeHandle(): StatusHandle & { setStatus: ReturnType<typeof vi.fn> } {
  let pollTimer: ReturnType<typeof setInterval> | undefined
  return {
    disposed: false,
    get polling() {
      return pollTimer !== undefined
    },
    setStatus: vi.fn(),
    setPollTimer(timer) {
      pollTimer = timer
    },
  }
}

function assistantTextEntry(text: string): string {
  return JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

describe('poll fallback — null ticks are skipped, late discovery is retried', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(findNewestPiSessionFile).mockReset()
    vi.mocked(readPiSessionFile).mockReset()
    vi.mocked(queryOpencodeSessionIdFromCli).mockReset()
    vi.mocked(fetchOpencodeMessages).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pi: a tick that resolves null status is skipped (setStatus not called)', async () => {
    vi.mocked(findNewestPiSessionFile).mockResolvedValue(null)
    const handle = makeHandle()

    piBackend.beginStatusTracking?.({
      cwd: '/tmp/wt-pi-null',
      isInitialStart: true,
      handle,
    })

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)

    expect(handle.setStatus).not.toHaveBeenCalled()
    expect(handle.polling).toBe(true)
  })

  it('pi: discovers the session file late, then reports status once found', async () => {
    vi.mocked(findNewestPiSessionFile)
      .mockResolvedValueOnce(null) // immediate tick: not found yet
      .mockResolvedValueOnce('/tmp/wt-pi-late/run1.jsonl') // next tick: found
    vi.mocked(readPiSessionFile).mockResolvedValue(assistantTextEntry(DONE_MARKER))
    const handle = makeHandle()

    piBackend.beginStatusTracking?.({
      cwd: '/tmp/wt-pi-late',
      isInitialStart: true,
      handle,
    })

    // Immediate tick: no file yet — no status reported.
    await Promise.resolve()
    await Promise.resolve()
    expect(handle.setStatus).not.toHaveBeenCalled()

    // Next tick: file discovered — status reported.
    await vi.advanceTimersByTimeAsync(2000)
    expect(handle.setStatus).toHaveBeenCalledWith('done')

    // File is now cached — subsequent ticks don't re-run discovery.
    await vi.advanceTimersByTimeAsync(2000)
    expect(findNewestPiSessionFile).toHaveBeenCalledTimes(2)
  })

  it('opencode: a tick with no recoverable sid is skipped (setStatus not called)', async () => {
    vi.mocked(queryOpencodeSessionIdFromCli).mockResolvedValue(null)
    const handle = makeHandle()

    opencodeBackend.beginStatusTracking?.({
      cwd: '/tmp/wt-oc-null',
      opencodePort: 4000,
      isInitialStart: false,
      handle,
    })

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)

    expect(handle.setStatus).not.toHaveBeenCalled()
    expect(fetchOpencodeMessages).not.toHaveBeenCalled()
  })

  it('opencode: recovers a sid late, then reports status once found', async () => {
    vi.mocked(queryOpencodeSessionIdFromCli)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('ses_recovered')
    vi.mocked(fetchOpencodeMessages).mockResolvedValue([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: DONE_MARKER }] },
    ])
    const handle = makeHandle()

    opencodeBackend.beginStatusTracking?.({
      cwd: '/tmp/wt-oc-late',
      opencodePort: 4001,
      isInitialStart: false,
      handle,
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(handle.setStatus).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(handle.setStatus).toHaveBeenCalledWith('done')
    expect(fetchOpencodeMessages).toHaveBeenCalledWith(4001, 'ses_recovered')
  })

  it('opencode: isInitialStart still returns early without polling', () => {
    const handle = makeHandle()
    opencodeBackend.beginStatusTracking?.({
      cwd: '/tmp/wt-oc-initial',
      opencodePort: 4002,
      isInitialStart: true,
      handle,
    })
    expect(handle.polling).toBe(false)
  })
})
