import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseTranscriptMessages, completeLines, createChatCursor } from './transcriptMessages.js'

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'transcript.jsonl',
)

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8')
}

// ─── parseTranscriptMessages ────────────────────────────────────────────────

describe('parseTranscriptMessages', () => {
  it('parses a real-shaped transcript excerpt into chat messages, oldest first', () => {
    const messages = parseTranscriptMessages(loadFixture())
    expect(messages.map((m) => m.uuid)).toEqual([
      'u1-prompt',
      'a2-text',
      'a3-tool-use',
      'u2-tool-result',
      'a4-final',
    ])
  })

  it('skips non-user/assistant transcript lines (queue-operation etc.)', () => {
    const raw = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: 't' })
    expect(parseTranscriptMessages(raw)).toEqual([])
  })

  it('skips isSidechain:true lines (subagent chatter)', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'sub',
      isSidechain: true,
      timestamp: '2026-07-19T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(parseTranscriptMessages(raw)).toEqual([])
  })

  it('skips a malformed/partial trailing line without throwing', () => {
    const good = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    })
    const raw = good + '\n{"type":"assistant","uuid":"a1","message":{"role":"assistant","conte'
    const messages = parseTranscriptMessages(raw)
    expect(messages).toHaveLength(1)
    expect(messages[0].uuid).toBe('u1')
  })

  it('drops a line whose only content block is unrenderable (thinking-only)', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
    })
    expect(parseTranscriptMessages(raw)).toEqual([])
  })

  it('treats plain-string message content as a single text block', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: { role: 'user', content: 'plain prompt' },
    })
    expect(parseTranscriptMessages(raw)).toEqual([
      {
        uuid: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'plain prompt' }],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it('parses a tool_use block, defaulting a missing input to {}', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }],
      },
    })
    expect(parseTranscriptMessages(raw)).toEqual([
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it('flattens an array-of-parts tool_result content and carries isError', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
            is_error: true,
          },
        ],
      },
    })
    expect(parseTranscriptMessages(raw)).toEqual([
      {
        uuid: 'u1',
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            content: 'line one\nline two',
            isError: true,
          },
        ],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it.each([
    ['missing uuid', { type: 'user', timestamp: 't', message: { role: 'user', content: 'hi' } }],
    ['missing timestamp', { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }],
    [
      'non-parseable timestamp',
      {
        type: 'user',
        uuid: 'u1',
        timestamp: 'not-a-date',
        message: { role: 'user', content: 'hi' },
      },
    ],
    ['missing message', { type: 'user', uuid: 'u1', timestamp: '2026-07-19T10:00:00.000Z' }],
    [
      'unknown message role',
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-19T10:00:00.000Z',
        message: { role: 'system', content: 'hi' },
      },
    ],
    ['not an object', '"just a string"'],
    ['malformed json', '{nope'],
  ])('drops a line with %s', (_name, line) => {
    const raw = typeof line === 'string' ? line : JSON.stringify(line)
    expect(parseTranscriptMessages(raw)).toEqual([])
  })

  it('skips blank lines', () => {
    expect(parseTranscriptMessages('\n\n   \n')).toEqual([])
  })
})

// ─── completeLines ───────────────────────────────────────────────────────────

describe('completeLines', () => {
  it('returns everything up to and including the last newline', () => {
    const { complete, consumedBytes } = completeLines('line1\nline2\npartial')
    expect(complete).toBe('line1\nline2\n')
    expect(consumedBytes).toBe(Buffer.byteLength('line1\nline2\n', 'utf8'))
  })

  it('returns consumedBytes:0 when there is no complete line yet', () => {
    expect(completeLines('no newline here')).toEqual({ complete: '', consumedBytes: 0 })
    expect(completeLines('')).toEqual({ complete: '', consumedBytes: 0 })
  })

  it('counts UTF-8 bytes, not JS string length, for multi-byte content', () => {
    // "café\n" — é is 2 bytes in UTF-8 but 1 UTF-16 code unit.
    const { complete, consumedBytes } = completeLines('café\n')
    expect(complete).toBe('café\n')
    expect(consumedBytes).toBe(Buffer.byteLength('café\n', 'utf8'))
    expect(consumedBytes).not.toBe(complete.length)
  })
})

// ─── createChatCursor ────────────────────────────────────────────────────────

describe('createChatCursor', () => {
  it('returns only messages not yet delivered, deduping by uuid across re-reads', () => {
    const cursor = createChatCursor()
    const raw = loadFixture()
    const { complete } = completeLines(raw)

    const first = cursor.next(complete)
    expect(first.map((m) => m.uuid)).toEqual([
      'u1-prompt',
      'a2-text',
      'a3-tool-use',
      'u2-tool-result',
      'a4-final',
    ])

    // A watcher re-reading the same (or overlapping) tail must not redeliver.
    const second = cursor.next(complete)
    expect(second).toEqual([])
  })

  it('delivers only the newly-appended message when the tail grows', () => {
    const cursor = createChatCursor()
    const line1 = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    })
    const line2 = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-19T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })

    expect(cursor.next(line1 + '\n').map((m) => m.uuid)).toEqual(['u1'])
    expect(cursor.next(line1 + '\n' + line2 + '\n').map((m) => m.uuid)).toEqual(['a1'])
  })

  it('combined with completeLines, never drops or duplicates a message across a mid-line fs event (the watcher loop)', () => {
    const line1 = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-19T10:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    })
    const line2 = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-19T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })

    // Simulate the file growing in three writes: a full line, then a second
    // line still being written (no trailing newline yet — an fs event can
    // fire mid-write), then the same line completed.
    const writes = [line1 + '\n', line1 + '\n' + line2.slice(0, 10), line1 + '\n' + line2 + '\n']

    const cursor = createChatCursor()
    let offset = 0
    const delivered: string[] = []
    for (const file of writes) {
      const tail = file.slice(offset)
      const { complete, consumedBytes } = completeLines(tail)
      if (consumedBytes === 0) continue // nothing complete yet — wait for the next event
      offset += consumedBytes
      delivered.push(...cursor.next(complete).map((m) => m.uuid))
    }

    expect(delivered).toEqual(['u1', 'a1'])
  })
})
