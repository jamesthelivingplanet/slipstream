import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCursor, startChatTail } from './chatTail.js'

interface TestMsg {
  uuid: string
  text: string
}

function parseTestLines(raw: string): TestMsg[] {
  const out: TestMsg[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as TestMsg)
    } catch {
      /* skip malformed/partial lines, same leniency as the real parsers */
    }
  }
  return out
}

// ─── createCursor ─────────────────────────────────────────────────────────────

describe('createCursor', () => {
  it('dedupes by uuid across repeated next() calls with the same raw text', () => {
    const cursor = createCursor(parseTestLines)
    const raw = JSON.stringify({ uuid: 'a', text: 'one' }) + '\n'
    expect(cursor.next(raw).map((m) => m.uuid)).toEqual(['a'])
    expect(cursor.next(raw)).toEqual([])
  })

  it('delivers only the newly-appended message as the raw text grows', () => {
    const cursor = createCursor(parseTestLines)
    const line1 = JSON.stringify({ uuid: 'a', text: 'one' })
    const line2 = JSON.stringify({ uuid: 'b', text: 'two' })
    expect(cursor.next(line1 + '\n').map((m) => m.uuid)).toEqual(['a'])
    expect(cursor.next(line1 + '\n' + line2 + '\n').map((m) => m.uuid)).toEqual(['b'])
  })

  it('works with a different parser instance per call (no shared state across cursors)', () => {
    const cursorA = createCursor(parseTestLines)
    const cursorB = createCursor(parseTestLines)
    const raw = JSON.stringify({ uuid: 'a', text: 'one' }) + '\n'
    expect(cursorA.next(raw).map((m) => m.uuid)).toEqual(['a'])
    expect(cursorB.next(raw).map((m) => m.uuid)).toEqual(['a']) // fresh cursor, not deduped by A's history
  })
})

// ─── startChatTail ────────────────────────────────────────────────────────────

describe('startChatTail', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-chattail-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('waits for a not-yet-existing file, then delivers once it appears (poke-triggered)', async () => {
    const file = path.join(dir, 'session.jsonl')
    const delivered: TestMsg[] = []
    const handle = startChatTail<TestMsg>({
      resolveFile: () => (fs.existsSync(file) ? file : null),
      parse: parseTestLines,
      onMessage: (m) => delivered.push(m),
      retryIntervalMs: 20,
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(delivered).toEqual([]) // not resolved yet — no crash, nothing delivered

    fs.writeFileSync(file, JSON.stringify({ uuid: 'a', text: 'hi' }) + '\n')
    handle.poke()

    await waitFor(() => delivered.length === 1)
    expect(delivered[0]).toEqual({ uuid: 'a', text: 'hi' })

    handle.dispose()
  })

  it('tails newly-appended lines and withholds a still-being-written trailing line', async () => {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, JSON.stringify({ uuid: 'a', text: 'one' }) + '\n')
    const delivered: TestMsg[] = []
    const handle = startChatTail<TestMsg>({
      resolveFile: () => file,
      parse: parseTestLines,
      onMessage: (m) => delivered.push(m),
    })

    await waitFor(() => delivered.length === 1)

    // Partial line (no trailing newline) — must not be delivered yet.
    fs.appendFileSync(file, JSON.stringify({ uuid: 'b', text: 'two' }).slice(0, 5))
    await new Promise((r) => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)

    // Complete the line.
    fs.appendFileSync(file, JSON.stringify({ uuid: 'b', text: 'two' }).slice(5) + '\n')
    await waitFor(() => delivered.length === 2)
    expect(delivered.map((m) => m.uuid)).toEqual(['a', 'b'])

    handle.dispose()
  })

  it('never redelivers a message already seen (dedupe survives repeated fs events)', async () => {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, JSON.stringify({ uuid: 'a', text: 'one' }) + '\n')
    const delivered: TestMsg[] = []
    const handle = startChatTail<TestMsg>({
      resolveFile: () => file,
      parse: parseTestLines,
      onMessage: (m) => delivered.push(m),
    })

    await waitFor(() => delivered.length === 1)

    // Touch the file without appending new content — a spurious fs event
    // must not redeliver 'a'.
    fs.utimesSync(file, new Date(), new Date())
    await new Promise((r) => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)

    handle.dispose()
  })

  it('dispose() stops delivering further messages', async () => {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, '')
    const delivered: TestMsg[] = []
    const handle = startChatTail<TestMsg>({
      resolveFile: () => file,
      parse: parseTestLines,
      onMessage: (m) => delivered.push(m),
    })
    await new Promise((r) => setTimeout(r, 50))
    handle.dispose()

    fs.appendFileSync(file, JSON.stringify({ uuid: 'a', text: 'hi' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(delivered).toEqual([])
  })

  it('poke() after dispose() is a harmless no-op', async () => {
    const handle = startChatTail<TestMsg>({
      resolveFile: () => null,
      parse: parseTestLines,
      onMessage: () => {},
      retryIntervalMs: 1000,
    })
    handle.dispose()
    expect(() => handle.poke()).not.toThrow()
  })

  it('restarts from offset 0 when the file shrinks (rotated/truncated)', async () => {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, JSON.stringify({ uuid: 'a', text: 'a long first line' }) + '\n')
    const delivered: TestMsg[] = []
    const handle = startChatTail<TestMsg>({
      resolveFile: () => file,
      parse: parseTestLines,
      onMessage: (m) => delivered.push(m),
    })
    await waitFor(() => delivered.length === 1)

    // Truncate and write a fresh file shorter than the previous byte offset —
    // simulates rotation (the new content is unrelated to what came before).
    fs.writeFileSync(file, JSON.stringify({ uuid: 'z', text: 'new' }) + '\n')
    await waitFor(() => delivered.length === 2)
    expect(delivered.map((m) => m.uuid)).toEqual(['a', 'z'])

    handle.dispose()
  })
})
