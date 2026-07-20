/**
 * Direct tests for the real SessionManager state machine (FLO-132).
 *
 * Every other test in the repo substitutes a fake `ISessionManager`, so the
 * real event ordering (`status` before `exit`, `disposed` suppression, watcher
 * teardown) was asserted nowhere. `createSessionManager` now takes an
 * injectable `spawnAgent` (FLO-132); these tests feed it a stub PTY so the
 * whole machine runs in plain Node with no dependency on node-pty's Electron
 * native ABI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import type { IPty, IEvent, IDisposable } from 'node-pty'

// Keep the native addon out of the test entirely — the spawn seam (FLO-132)
// lets the whole state machine run against a stub PTY in plain Node.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
// Hermetic: don't mutate ~/.claude.json on every launch (trustDirectory).
vi.mock('./claudeTrust.js', () => ({ trustDirectory: vi.fn(), withTrustedDir: vi.fn() }))

import { createSessionManager, type SpawnAgent } from './sessionManager.js'
import { STATUS_SENTINEL_FILE } from './statusSentinel.js'
import { OUTCOME_SENTINEL_FILE } from './outcomeSentinel.js'
import { AGENT_EVENTS_FILE } from './agentEventsSentinel.js'
import type {
  ISessionManager,
  RepoDTO,
  SessionAgentEventDTO,
  SessionEvents,
  SessionOutcomeDTO,
  SessionStatus,
  StartSessionInput,
  StatusMeta,
} from '../shared/contract.js'

// ─── Stub PTY ─────────────────────────────────────────────────────────────────

type DataListener = (data: string) => void
type ExitListener = (e: { exitCode: number; signal?: number }) => void

/** Minimal in-process stand-in for a node-pty IPty. The test drives it by
 *  calling emitData/emitExit; SessionManager drives it via write/resize/kill. */
class StubPty {
  readonly pid = 1000 + Math.floor(Math.random() * 9000)
  cols: number
  rows: number
  readonly process = 'stub-agent'
  handleFlowControl = false
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  killCount = 0
  killedSignal: string | undefined

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }

  readonly onData: IEvent<string> = (listener: DataListener): IDisposable => {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }
  readonly onExit: IEvent<{ exitCode: number; signal?: number }> = (
    listener: ExitListener,
  ): IDisposable => {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  emitData(chunk: string): void {
    for (const l of this.dataListeners) l(chunk)
  }
  emitExit(exitCode: number, signal?: number): void {
    for (const l of this.exitListeners) l({ exitCode, signal })
  }

  write(data: string | Buffer): void {
    this.writes.push(typeof data === 'string' ? data : data.toString('utf8'))
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.resizes.push({ cols, rows })
  }
  kill(signal?: string): void {
    this.killCount++
    this.killedSignal = signal
  }
  clear(): void {}
  pause(): void {}
  resume(): void {}
}

// ─── Harness ──────────────────────────────────────────────────────────────────

interface RecordedEvent {
  ev: keyof SessionEvents
  sid: string
  /** Everything after the sessionId arg, in order. */
  rest: unknown[]
}

interface Recorder {
  log: RecordedEvent[]
  status: Array<{ sid: string; status: SessionStatus; meta?: StatusMeta }>
  exit: Array<{ sid: string; code: number }>
  data: Array<{ sid: string; chunk: string; seq: number }>
  pr: Array<{ sid: string; url: string }>
  outcome: Array<{ sid: string; o: SessionOutcomeDTO }>
  agentEvent: Array<{ sid: string; e: SessionAgentEventDTO }>
  input: string[]
}

function attach(mgr: ISessionManager): Recorder {
  const log: RecordedEvent[] = []
  const rec: Recorder = {
    log,
    status: [],
    exit: [],
    data: [],
    pr: [],
    outcome: [],
    agentEvent: [],
    input: [],
  }
  mgr.on('status', (sid, status, meta) => {
    log.push({ ev: 'status', sid, rest: [status, meta] })
    rec.status.push({ sid, status, meta })
  })
  mgr.on('exit', (sid, code) => {
    log.push({ ev: 'exit', sid, rest: [code] })
    rec.exit.push({ sid, code })
  })
  mgr.on('data', (sid, chunk, seq) => {
    log.push({ ev: 'data', sid, rest: [chunk, seq] })
    rec.data.push({ sid, chunk, seq })
  })
  mgr.on('pr', (sid, url) => {
    log.push({ ev: 'pr', sid, rest: [url] })
    rec.pr.push({ sid, url })
  })
  mgr.on('outcome', (sid, o) => {
    log.push({ ev: 'outcome', sid, rest: [o] })
    rec.outcome.push({ sid, o })
  })
  mgr.on('agentEvent', (sid, e) => {
    log.push({ ev: 'agentEvent', sid, rest: [e] })
    rec.agentEvent.push({ sid, e })
  })
  mgr.on('input', (sid) => {
    log.push({ ev: 'input', sid, rest: [] })
    rec.input.push(sid)
  })
  return rec
}

const REPO: RepoDTO = {
  id: 'r1',
  org: 'acme',
  name: 'api',
  base: 'main',
  path: '/repos/api',
}

function makeStartInput(overrides: Partial<StartSessionInput> = {}): StartSessionInput {
  return {
    tid: 'T-1',
    title: 'Fix bug',
    prompt: 'fix it',
    repo: REPO,
    branch: 't-1-fix-bug',
    cwd: '<set-by-beforeEach>',
    agentKind: 'claude-code',
    ...overrides,
  }
}

interface Harness {
  mgr: ISessionManager
  pties: StubPty[]
  spawnCalls: Array<{ cmd: string; args: string[]; cwd: string; cols: number; rows: number }>
}

let activeMgr: ISessionManager | undefined
let worktree: string
let tmpRoot: string | undefined
let prevClaudeConfigDir: string | undefined

function setup(opts: { root?: string } = {}): Harness {
  const pties: StubPty[] = []
  const spawnCalls: Harness['spawnCalls'] = []
  const spawn: SpawnAgent = (cmd, args, cwd, cols, rows) => {
    spawnCalls.push({ cmd, args, cwd, cols, rows })
    const p = new StubPty(cols, rows)
    pties.push(p)
    return p as unknown as IPty
  }
  tmpRoot = opts.root
  const mgr = createSessionManager(undefined, opts.root, spawn)
  activeMgr = mgr
  return { mgr, pties, spawnCalls }
}

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  const loop = (resolve: () => void, reject: (e: Error) => void) => {
    if (pred()) return resolve()
    if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
    setTimeout(() => loop(resolve, reject), 10)
  }
  return new Promise((resolve, reject) => loop(resolve, reject))
}

/** Re-write a sentinel file with a fresh ts until `pred` is true. fs.watch only
 *  fires on post-registration changes, so this both waits for the watcher to be
 *  installed and pumps the event through it. */
async function pumpSentinel(
  dir: string,
  file: string,
  makeContent: () => string,
  pred: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const full = path.join(dir, file)
  const start = Date.now()
  fs.mkdirSync(dir, { recursive: true })
  do {
    fs.writeFileSync(full, makeContent())
    if (pred()) return
    await new Promise((r) => setTimeout(r, 15))
  } while (Date.now() - start < timeoutMs)
  throw new Error(`timed out waiting for sentinel ${file}`)
}

/** Write a sentinel a few times without asserting — used to prove a watcher is
 *  no longer firing (teardown). */
async function nudgeSentinel(
  dir: string,
  file: string,
  makeContent: () => string,
  ms = 250,
): Promise<void> {
  const full = path.join(dir, file)
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      fs.writeFileSync(full, makeContent())
    } catch {
      /* dir may be gone after teardown */
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-wt-'))
  // Real worktrees are git checkouts; initializing one keeps promptWriter's
  // `ensureIgnored` (which shells out to `git rev-parse`) from spewing stderr.
  try {
    childProcess.execSync('git init -q', { cwd: worktree, stdio: 'ignore' })
  } catch {
    /* git unavailable — tests still pass, just noisier */
  }
  // Keep the chat-tail transcript resolver from scanning the real ~/.claude.
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'sm-claude-config-' + Date.now())
})

afterEach(() => {
  try {
    activeMgr?.killAll()
  } catch {
    /* best-effort */
  }
  activeMgr = undefined
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  tmpRoot = undefined
  fs.rmSync(worktree, { recursive: true, force: true })
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
})

function withCwd(input: StartSessionInput, cwd: string): StartSessionInput {
  return { ...input, cwd }
}

// ─── launch / lifecycle event ordering ────────────────────────────────────────

describe('SessionManager — launch & lifecycle', () => {
  it('start spawns exactly one PTY and emits an initial "running" status', () => {
    const { mgr, pties, spawnCalls } = setup()
    const rec = attach(mgr)
    const dto = mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    expect(pties).toHaveLength(1)
    expect(spawnCalls[0]).toMatchObject({ cwd: worktree, cols: 80, rows: 30 })
    expect(dto.status).toBe('running')
    expect(dto.id).toBe('s1')
    expect(rec.status).toEqual([{ sid: 's1', status: 'running', meta: undefined }])
    expect(mgr.has('s1')).toBe(true)
  })

  it('prepends parsed extraArgs to the launch command args (TASK-UQF55)', () => {
    const { mgr, spawnCalls } = setup()
    mgr.start(
      withCwd(makeStartInput({ sessionId: 's1', extraArgs: '--advisor --chrome' }), worktree),
    )

    expect(spawnCalls[0].args.slice(0, 2)).toEqual(['--advisor', '--chrome'])
  })

  it('throws when extraArgs has an unterminated quote (TASK-UQF55)', () => {
    const { mgr } = setup()
    expect(() =>
      mgr.start(
        withCwd(makeStartInput({ sessionId: 's2', extraArgs: '--bad "unterminated' }), worktree),
      ),
    ).toThrow()
  })

  it('emits a data event (with monotonic seq) for each PTY chunk', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    pties[0].emitData('hello ')
    pties[0].emitData('world')

    expect(rec.data.map((d) => d.chunk)).toEqual(['hello ', 'world'])
    expect(rec.data[0].seq).toBeLessThanOrEqual(rec.data[1].seq)
    expect(rec.data[1].seq).toBeGreaterThan(0)
  })

  it('on PTY exit emits status BEFORE exit (the core ordering invariant)', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    pties[0].emitExit(0)

    const sidEvents = rec.log.filter((l) => l.sid === 's1')
    const exitIdx = sidEvents.findIndex((l) => l.ev === 'exit')
    expect(exitIdx).toBeGreaterThan(-1)
    // The event immediately preceding exit must be a status, and it must be
    // the post-exit status ('done' for exit code 0).
    expect(sidEvents[exitIdx - 1].ev).toBe('status')
    expect(sidEvents[exitIdx - 1].rest[0]).toBe('done')
    expect(rec.exit).toEqual([{ sid: 's1', code: 0 }])
    expect(mgr.has('s1')).toBe(false)
  })

  it('a non-zero exit code surfaces as status "errored"', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    pties[0].emitExit(2)

    expect(rec.status.at(-1)).toMatchObject({ sid: 's1', status: 'errored' })
    expect(rec.exit).toEqual([{ sid: 's1', code: 2 }])
  })
})

// ─── disposed suppression ─────────────────────────────────────────────────────

describe('SessionManager — disposed suppression', () => {
  it('kill() kills the PTY and suppresses the trailing status/exit emissions', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    const before = rec.log.length

    mgr.kill('s1')

    // kill itself emits nothing…
    expect(rec.log.length).toBe(before)
    expect(pties[0].killCount).toBe(1)
    expect(mgr.has('s1')).toBe(false)

    // …and when the killed PTY's exit finally lands, it is suppressed
    // (rec.disposed short-circuits the onExit handler).
    pties[0].emitExit(0)
    expect(rec.log.length).toBe(before)
    expect(rec.exit).toEqual([])
  })

  it('reap() reports a "reaped" status and suppresses the exit emission', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    mgr.reap('s1')

    expect(rec.status.at(-1)).toMatchObject({ sid: 's1', status: 'reaped' })
    expect(pties[0].killCount).toBe(1)
    expect(mgr.has('s1')).toBe(false)

    const reapedStatusCount = rec.status.filter((s) => s.status === 'reaped').length
    pties[0].emitExit(0)
    // No further status/exit after the suppressed onExit.
    expect(rec.status.filter((s) => s.status === 'reaped').length).toBe(reapedStatusCount)
    expect(rec.exit).toEqual([])
  })
})

// ─── handoff / attachRemoteControl ────────────────────────────────────────────

describe('SessionManager — handoff', () => {
  it('kills the previous PTY (exit suppressed) and spawns the new kind under the same id', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    const dto = mgr.start(
      withCwd(makeStartInput({ sessionId: 's1', agentKind: 'claude-code' }), worktree),
    )
    const oldPty = pties[0]

    const next = mgr.handoff({
      session: dto,
      cwd: worktree,
      agentKind: 'opencode',
      handoffPrompt: 'take over',
    })

    expect(pties).toHaveLength(2)
    expect(next.id).toBe('s1')
    expect(next.agentKind).toBe('opencode')
    expect(next.status).toBe('running')
    expect(oldPty.killCount).toBe(1)
    expect(mgr.has('s1')).toBe(true)

    // The old agent's exit must NOT surface (handoff sets disposed=true before
    // killing, exactly like kill()).
    oldPty.emitExit(0)
    expect(rec.exit).toEqual([])
  })
})

describe('SessionManager — attachRemoteControl', () => {
  it('replaces a live session: old PTY killed (exit suppressed), new one spawned', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    const dto = mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    const oldPty = pties[0]

    mgr.attachRemoteControl({ session: dto, cwd: worktree })

    expect(pties).toHaveLength(2)
    expect(oldPty.killCount).toBe(1)
    expect(mgr.has('s1')).toBe(true)

    oldPty.emitExit(0)
    expect(rec.exit).toEqual([])
  })
})

// ─── resume ───────────────────────────────────────────────────────────────────

describe('SessionManager — resume', () => {
  it('returns the existing live dto without respawning when the session is still live', () => {
    const { mgr, pties } = setup()
    const dto = mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    const spawnedBefore = pties.length

    const resumed = mgr.resume({ session: dto, cwd: worktree })

    expect(pties.length).toBe(spawnedBefore)
    expect(resumed.id).toBe('s1')
  })
})

// ─── write / resize / has / liveSessions ──────────────────────────────────────

describe('SessionManager — write / resize / liveSessions', () => {
  it('write() forwards bytes to the PTY and emits an input event', () => {
    const { mgr, pties } = setup()
    const rec = attach(mgr)
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    mgr.write('s1', 'y\r')

    expect(pties[0].writes).toEqual(['y\r'])
    expect(rec.input).toEqual(['s1'])
  })

  it('resize() resizes both the PTY and the screen store', () => {
    const { mgr, pties } = setup()
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))

    mgr.resize('s1', 132, 40)

    expect(pties[0].resizes).toEqual([{ cols: 132, rows: 40 }])
    expect(pties[0].cols).toBe(132)
    expect(pties[0].rows).toBe(40)
  })

  it('liveSessions() reflects live PTYs and clears after killAll()', () => {
    const { mgr } = setup()
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    mgr.start(withCwd(makeStartInput({ sessionId: 's2' }), worktree))

    expect(
      mgr
        .liveSessions()
        .map((l) => l.id)
        .sort(),
    ).toEqual(['s1', 's2'])

    mgr.killAll()

    expect(mgr.liveSessions()).toHaveLength(0)
  })

  it('write/resize/kill/getBuffer on an unknown id are no-ops (never throw)', async () => {
    const { mgr } = setup()
    expect(() => mgr.write('nope', 'x')).not.toThrow()
    expect(() => mgr.resize('nope', 10, 10)).not.toThrow()
    expect(() => mgr.kill('nope')).not.toThrow()
    expect(() => mgr.reap('nope')).not.toThrow()
    await expect(mgr.getBuffer('nope')).resolves.toEqual({ data: '', seq: 0 })
  })
})

// ─── getBuffer for a live session ─────────────────────────────────────────────

describe('SessionManager — getBuffer (live)', () => {
  it('returns a screen snapshot containing the emitted PTY output', async () => {
    const { mgr, pties } = setup()
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    pties[0].emitData('hello world\r\n')

    const buf = await mgr.getBuffer('s1')

    expect(buf.data).toContain('hello world')
    expect(buf.seq).toBeGreaterThan(0)
  })
})

// ─── scrollback: dead-session serialization + resume replay (needs root) ──────

describe('SessionManager — scrollback (root provided)', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-root-'))
  })

  async function waitForWatcher(mgr: ISessionManager, id: string): Promise<Recorder> {
    const rec = attach(mgr)
    await pumpSentinel(
      path.join(root, 'sessions', id),
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'done', ts: Date.now() }),
      () => rec.status.some((s) => s.sid === id && s.status === 'done'),
    )
    return rec
  }

  it('getBuffer() serializes persisted scrollback for a dead session (seq = raw length)', async () => {
    const { mgr, pties } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    // Wait for the watcher so the exit handler's teardown isn't racy.
    await waitForWatcher(mgr, 's1')

    const chunk = 'persisted output here'
    pties[0].emitData(chunk)
    pties[0].emitExit(0)

    expect(mgr.has('s1')).toBe(false)
    const buf = await mgr.getBuffer('s1')
    expect(buf.data).toContain('persisted output here')
    expect(buf.seq).toBe(chunk.length)
  })

  it('resume() replays persisted scrollback as a data event before live output', async () => {
    const { mgr, pties } = setup({ root })
    const dto = mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    await waitForWatcher(mgr, 's1')
    pties[0].emitData('replay me')
    pties[0].emitExit(0) // natural death → scrollback persisted, session gone

    const rec = attach(mgr)
    mgr.resume({ session: { ...dto, status: 'done' }, cwd: worktree })

    expect(pties.length).toBe(2)
    await waitFor(() => rec.data.some((d) => d.sid === 's1' && d.chunk.includes('replay me')))
  })
})

// ─── sentinel fs.watch multiplexer + teardown ─────────────────────────────────

describe('SessionManager — sentinel watcher', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-watch-'))
  })

  async function waitForWatcher(mgr: ISessionManager, id: string): Promise<Recorder> {
    const rec = attach(mgr)
    await pumpSentinel(
      path.join(root, 'sessions', id),
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'done', ts: Date.now() }),
      () => rec.status.some((s) => s.sid === id && s.status === 'done'),
    )
    return rec
  }

  it('multiplexes status.json -> status (with reason/message meta)', async () => {
    const { mgr } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    const rec = await waitForWatcher(mgr, 's1')
    const statusBefore = rec.status.length

    await pumpSentinel(
      path.join(root, 'sessions', 's1'),
      STATUS_SENTINEL_FILE,
      () =>
        JSON.stringify({
          state: 'needs',
          reason: 'approval',
          message: 'ok to push?',
          ts: Date.now(),
        }),
      () => rec.status.length > statusBefore,
    )

    const last = rec.status.at(-1)!
    expect(last.sid).toBe('s1')
    expect(last.status).toBe('needs')
    expect(last.meta).toEqual({ reason: 'approval', message: 'ok to push?' })
    expect(mgr.getSessionActivity?.('s1')).toBe('ok to push?')
  })

  it('clears the activity message once status leaves "needs"', async () => {
    const { mgr } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    await waitForWatcher(mgr, 's1')
    const rec = attach(mgr)

    await pumpSentinel(
      path.join(root, 'sessions', 's1'),
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'needs', message: 'waiting', ts: Date.now() }),
      () => mgr.getSessionActivity?.('s1') === 'waiting',
    )
    expect(mgr.getSessionActivity?.('s1')).toBe('waiting')

    await pumpSentinel(
      path.join(root, 'sessions', 's1'),
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'running', ts: Date.now() }),
      () => mgr.getSessionActivity?.('s1') === undefined,
    )
    expect(mgr.getSessionActivity?.('s1')).toBeUndefined()
    expect(rec.status.at(-1)).toMatchObject({ sid: 's1', status: 'running' })
  })

  it('emits outcome.json -> outcome (deduped by ts)', async () => {
    const { mgr } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    await waitForWatcher(mgr, 's1')
    const rec = attach(mgr)

    await pumpSentinel(
      path.join(root, 'sessions', 's1'),
      OUTCOME_SENTINEL_FILE,
      () => JSON.stringify({ result: 'success', summary: 'shipped', ts: Date.now() }),
      () => rec.outcome.some((o) => o.o.summary === 'shipped'),
    )

    expect(rec.outcome).toHaveLength(1)
    expect(rec.outcome[0].o).toMatchObject({
      sessionId: 's1',
      result: 'success',
      summary: 'shipped',
    })
  })

  it('emits events.ndjson -> agentEvent (only rows newer than the cursor)', async () => {
    const { mgr } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    await waitForWatcher(mgr, 's1')
    const rec = attach(mgr)

    const ts = Date.now()
    await pumpSentinel(
      path.join(root, 'sessions', 's1'),
      AGENT_EVENTS_FILE,
      () =>
        JSON.stringify({ kind: 'checkpoint', message: 'first', ts }) +
        '\n' +
        JSON.stringify({ kind: 'artifact', path: '/tmp/a.txt', ts: ts + 1 }) +
        '\n',
      () => rec.agentEvent.length >= 2,
    )

    expect(rec.agentEvent.map((a) => a.e.kind)).toEqual(['checkpoint', 'artifact'])
    expect(rec.agentEvent[0].e).toMatchObject({ sessionId: 's1', message: 'first' })
    expect(rec.agentEvent[1].e).toMatchObject({ sessionId: 's1', path: '/tmp/a.txt' })
  })

  it('emits pr.json -> pr (deduped by url across repeated writes)', async () => {
    const { mgr } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    await waitForWatcher(mgr, 's1')
    const rec = attach(mgr)

    const url = 'https://git.example/acme/api/-/merge_requests/1'
    await pumpSentinel(
      path.join(root, 'sessions', 's1'),
      'pr.json',
      () => JSON.stringify({ url }),
      () => rec.pr.some((p) => p.url === url),
    )

    // A second write of the same url must NOT re-emit.
    const before = rec.pr.length
    await nudgeSentinel(
      path.join(root, 'sessions', 's1'),
      'pr.json',
      () => JSON.stringify({ url }),
      200,
    )
    expect(rec.pr.length).toBe(before)
  })

  it('tears down the watcher on kill() (no further sentinel emissions)', async () => {
    const { mgr } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    const rec = await waitForWatcher(mgr, 's1')

    mgr.kill('s1')
    const statusBefore = rec.status.length

    await nudgeSentinel(
      path.join(root, 'sessions', 's1'),
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'errored', ts: Date.now() }),
      300,
    )

    expect(rec.status.length).toBe(statusBefore)
  })

  it('tears down the watcher on natural PTY exit', async () => {
    const { mgr, pties } = setup({ root })
    mgr.start(withCwd(makeStartInput({ sessionId: 's1' }), worktree))
    const rec = await waitForWatcher(mgr, 's1')

    pties[0].emitExit(0)
    const statusBefore = rec.status.length

    await nudgeSentinel(
      path.join(root, 'sessions', 's1'),
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'errored', ts: Date.now() }),
      300,
    )

    expect(rec.status.length).toBe(statusBefore)
  })
})
