/**
 * Direct tests for createSentinelWatcher (FLO-119): the fs.watch multiplexer,
 * per-file dedupe cursors, and pty-vs-poll status merge extracted out of
 * sessionManager's launch(). No PTY involved — just a real temp directory and
 * a real StatusDetector, so the merge logic (previously only reachable
 * through the whole session manager) is exercised directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSentinelWatcher, type SentinelWatcher } from './sentinelWatcher.js'
import { StatusDetector } from './statusDetector.js'
import { STATUS_SENTINEL_FILE } from './statusSentinel.js'
import { OUTCOME_SENTINEL_FILE, type OutcomeSentinel } from './outcomeSentinel.js'
import { AGENT_EVENTS_FILE, type AgentEventLine } from './agentEventsSentinel.js'
import type { SessionStatus, StatusMeta } from '../shared/contract.js'

let dir: string
let watchers: SentinelWatcher[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-watcher-'))
  watchers = []
})

afterEach(() => {
  for (const w of watchers) w.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Recorder {
  pr: string[]
  outcome: OutcomeSentinel[]
  agentEvent: AgentEventLine[]
  status: Array<{ status: SessionStatus; meta?: StatusMeta; activityMessage?: string }>
}

function watch(detector: StatusDetector, ptyDriven: boolean): Recorder {
  const rec: Recorder = { pr: [], outcome: [], agentEvent: [], status: [] }
  const w = createSentinelWatcher(dir, detector, ptyDriven, {
    onPr: (url) => rec.pr.push(url),
    onOutcome: (o) => rec.outcome.push(o),
    onAgentEvent: (e) => rec.agentEvent.push(e),
    onStatus: (status, meta, activityMessage) => rec.status.push({ status, meta, activityMessage }),
  })
  watchers.push(w)
  return rec
}

/** Re-write a file with fresh content until `pred` is true. fs.watch only
 *  fires on post-registration changes, so this both waits for the watcher to
 *  be installed and pumps the event through it. */
async function pump(
  file: string,
  makeContent: () => string,
  pred: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const full = path.join(dir, file)
  const start = Date.now()
  do {
    fs.writeFileSync(full, makeContent())
    if (pred()) return
    await new Promise((r) => setTimeout(r, 15))
  } while (Date.now() - start < timeoutMs)
  throw new Error(`timed out waiting for ${file}`)
}

/** Write a file repeatedly without asserting — proves a watcher is no longer
 *  reacting (teardown / dedupe). */
async function nudge(file: string, makeContent: () => string, ms = 250): Promise<void> {
  const full = path.join(dir, file)
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      fs.writeFileSync(full, makeContent())
    } catch {
      /* dir may be gone */
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('createSentinelWatcher — pr.json', () => {
  it('emits a url and dedupes repeated writes of the same url', async () => {
    const rec = watch(new StatusDetector(), false)
    const url = 'https://git.example/acme/api/-/merge_requests/1'

    await pump(
      'pr.json',
      () => JSON.stringify({ url }),
      () => rec.pr.length > 0,
    )
    expect(rec.pr).toEqual([url])

    await nudge('pr.json', () => JSON.stringify({ url }))
    expect(rec.pr).toEqual([url])
  })

  it('ignores malformed JSON', async () => {
    const rec = watch(new StatusDetector(), false)
    await nudge('pr.json', () => '{not json')
    expect(rec.pr).toEqual([])
  })
})

describe('createSentinelWatcher — outcome.json', () => {
  it('emits parsed outcomes and dedupes by ts (only strictly-newer fires)', async () => {
    const rec = watch(new StatusDetector(), false)
    const ts = Date.now()

    await pump(
      OUTCOME_SENTINEL_FILE,
      () => JSON.stringify({ result: 'success', summary: 'shipped', ts }),
      () => rec.outcome.length > 0,
    )
    expect(rec.outcome).toEqual([{ result: 'success', summary: 'shipped', ts }])

    // Same ts written again must not re-emit.
    await nudge(OUTCOME_SENTINEL_FILE, () =>
      JSON.stringify({ result: 'success', summary: 'shipped', ts }),
    )
    expect(rec.outcome).toHaveLength(1)

    // A strictly newer ts does emit.
    await pump(
      OUTCOME_SENTINEL_FILE,
      () => JSON.stringify({ result: 'partial', summary: 'half done', ts: ts + 1 }),
      () => rec.outcome.length > 1,
    )
    expect(rec.outcome[1]).toMatchObject({ result: 'partial', summary: 'half done' })
  })
})

describe('createSentinelWatcher — events.ndjson', () => {
  it('emits only rows newer than the cursor, advancing it across writes', async () => {
    const rec = watch(new StatusDetector(), false)
    const ts = Date.now()

    await pump(
      AGENT_EVENTS_FILE,
      () =>
        JSON.stringify({ kind: 'checkpoint', message: 'first', ts }) +
        '\n' +
        JSON.stringify({ kind: 'artifact', path: '/tmp/a.txt', ts: ts + 1 }) +
        '\n',
      () => rec.agentEvent.length >= 2,
    )
    expect(rec.agentEvent.map((e) => e.kind)).toEqual(['checkpoint', 'artifact'])

    // Re-writing the same two lines plus one new one only surfaces the new row.
    await pump(
      AGENT_EVENTS_FILE,
      () =>
        JSON.stringify({ kind: 'checkpoint', message: 'first', ts }) +
        '\n' +
        JSON.stringify({ kind: 'artifact', path: '/tmp/a.txt', ts: ts + 1 }) +
        '\n' +
        JSON.stringify({ kind: 'approval', message: 'ok?', ts: ts + 2 }) +
        '\n',
      () => rec.agentEvent.length >= 3,
    )
    expect(rec.agentEvent).toHaveLength(3)
    expect(rec.agentEvent[2]).toMatchObject({ kind: 'approval', message: 'ok?' })
  })

  it('skips malformed lines without losing well-formed ones', async () => {
    const rec = watch(new StatusDetector(), false)
    const ts = Date.now()

    await pump(
      AGENT_EVENTS_FILE,
      () => 'not json\n' + JSON.stringify({ kind: 'checkpoint', message: 'ok', ts }) + '\n',
      () => rec.agentEvent.length > 0,
    )
    expect(rec.agentEvent).toEqual([{ kind: 'checkpoint', message: 'ok', ts }])
  })
})

describe('createSentinelWatcher — status.json (poll-driven, ptyDriven=false)', () => {
  it('passes the sentinel state through verbatim', async () => {
    const rec = watch(new StatusDetector(), false)

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'needs', message: 'waiting', ts: Date.now() }),
      () => rec.status.length > 0,
    )

    expect(rec.status[0].status).toBe('needs')
    expect(rec.status[0].meta).toEqual({ reason: undefined, message: 'waiting' })
    expect(rec.status[0].activityMessage).toBe('waiting')
  })

  it('dedupes by ts (only strictly-newer writes fire)', async () => {
    const rec = watch(new StatusDetector(), false)
    const ts = Date.now()

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'running', ts }),
      () => rec.status.length > 0,
    )
    await nudge(STATUS_SENTINEL_FILE, () => JSON.stringify({ state: 'needs', ts }))
    expect(rec.status).toHaveLength(1)
  })

  it('clears activityMessage once the merged status leaves "needs"', async () => {
    const rec = watch(new StatusDetector(), false)
    const ts = Date.now()

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'needs', message: 'waiting', ts }),
      () => rec.status.length > 0,
    )
    expect(rec.status[0].activityMessage).toBe('waiting')

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'running', ts: ts + 1 }),
      () => rec.status.length > 1,
    )
    expect(rec.status[1].activityMessage).toBeUndefined()
  })

  it('has no meta when neither reason nor message is present', async () => {
    const rec = watch(new StatusDetector(), false)

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'done', ts: Date.now() }),
      () => rec.status.length > 0,
    )
    expect(rec.status[0].meta).toBeUndefined()
  })

  it('ignores malformed JSON', async () => {
    const rec = watch(new StatusDetector(), false)
    await nudge(STATUS_SENTINEL_FILE, () => '{not json')
    expect(rec.status).toEqual([])
  })
})

describe('createSentinelWatcher — status.json (pty-driven, ptyDriven=true)', () => {
  it('routes the sentinel state through the StatusDetector instead of using it verbatim', async () => {
    const detector = new StatusDetector()
    detector.markExit(1) // status() now always returns 'errored', overriding any signal
    const rec = watch(detector, true)

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'done', ts: Date.now() }),
      () => rec.status.length > 0,
    )

    // A poll-driven watcher would have reported 'done' verbatim; pty-driven
    // merges through the detector, which is sticky on the exit it recorded.
    expect(rec.status[0].status).toBe('errored')
  })

  it('applies the signal to the detector so a fresh detector reflects the reported state', async () => {
    const detector = new StatusDetector()
    const rec = watch(detector, true)

    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'needs', reason: 'approval', message: 'ok?', ts: Date.now() }),
      () => rec.status.length > 0,
    )

    expect(rec.status[0].status).toBe('needs')
    expect(rec.status[0].meta).toEqual({ reason: 'approval', message: 'ok?' })
    expect(rec.status[0].activityMessage).toBe('ok?')
  })
})

describe('createSentinelWatcher — close()', () => {
  it('stops all future emissions once closed', async () => {
    const rec = watch(new StatusDetector(), false)
    await pump(
      STATUS_SENTINEL_FILE,
      () => JSON.stringify({ state: 'running', ts: Date.now() }),
      () => rec.status.length > 0,
    )

    watchers.pop()!.close()
    const before = rec.status.length
    await nudge(STATUS_SENTINEL_FILE, () => JSON.stringify({ state: 'needs', ts: Date.now() }))
    expect(rec.status.length).toBe(before)
  })

  it('is safe to call immediately, before the async directory setup completes', async () => {
    const rec = watch(new StatusDetector(), false)
    watchers.pop()!.close()

    await nudge(STATUS_SENTINEL_FILE, () => JSON.stringify({ state: 'running', ts: Date.now() }))
    expect(rec.status).toEqual([])
  })
})
