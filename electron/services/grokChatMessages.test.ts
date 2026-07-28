import { describe, it, expect } from 'vitest'
import { mapGrokMessageRow, parseGrokMessages, type GrokMessageRow } from './grokChatMessages.js'

function row(overrides: Partial<GrokMessageRow> & { message: unknown }): GrokMessageRow {
  const { message, ...rest } = overrides
  return {
    session_id: 'ses_1',
    seq: 0,
    role: (message as Record<string, unknown>)['role'] as string,
    message_json: JSON.stringify(message),
    created_at: '2026-07-19T10:00:00.000Z',
    ...rest,
  }
}

describe('mapGrokMessageRow', () => {
  it('maps a user string-content message', () => {
    const r = row({ seq: 1, message: { role: 'user', content: 'hi' } })
    expect(mapGrokMessageRow(r)).toEqual({
      uuid: 'ses_1:1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      ts: Date.parse('2026-07-19T10:00:00.000Z'),
    })
  })

  it('maps a user array-content message', () => {
    const r = row({
      seq: 2,
      message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    })
    expect(mapGrokMessageRow(r)).toEqual({
      uuid: 'ses_1:2',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello there' }],
      ts: Date.parse('2026-07-19T10:00:00.000Z'),
    })
  })

  it('maps assistant text content', () => {
    const r = row({
      seq: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sure thing' }] },
    })
    expect(mapGrokMessageRow(r)).toEqual({
      uuid: 'ses_1:3',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'sure thing' }],
      ts: Date.parse('2026-07-19T10:00:00.000Z'),
    })
  })

  it('maps an assistant message with an embedded tool-call', () => {
    const r = row({
      seq: 4,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running it' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'bash', input: { cmd: 'ls' } },
        ],
      },
    })
    const msg = mapGrokMessageRow(r)
    expect(msg?.blocks).toEqual([
      { type: 'text', text: 'running it' },
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } },
    ])
  })

  it('defaults a tool-call with no input to {}', () => {
    const r = row({
      seq: 5,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'bash' }],
      },
    })
    expect(mapGrokMessageRow(r)?.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
    ])
  })

  it('maps role:tool to a synthetic role:user DTO carrying tool_result blocks', () => {
    const r = row({
      seq: 6,
      message: {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'bash',
            output: { type: 'text', value: 'file.txt' },
          },
        ],
      },
    })
    expect(mapGrokMessageRow(r)).toEqual({
      uuid: 'ses_1:6',
      role: 'user',
      blocks: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file.txt' }],
      ts: Date.parse('2026-07-19T10:00:00.000Z'),
    })
  })

  describe('ToolResultOutput variants', () => {
    it.each([
      ['text', { type: 'text', value: 'plain output' }, 'plain output', undefined],
      ['json', { type: 'json', value: { ok: true } }, JSON.stringify({ ok: true }), undefined],
      ['error-text', { type: 'error-text', value: 'boom' }, 'boom', true],
      ['error-json', { type: 'error-json', value: { code: 1 } }, JSON.stringify({ code: 1 }), true],
      [
        'execution-denied with reason',
        { type: 'execution-denied', reason: 'user declined' },
        'user declined',
        true,
      ],
      ['execution-denied without reason', { type: 'execution-denied' }, 'Execution denied', true],
      [
        'content',
        {
          type: 'content',
          value: [
            { type: 'text', text: 'a' },
            { type: 'image', data: 'x' },
            { type: 'text', text: 'b' },
          ],
        },
        'a\nb',
        undefined,
      ],
    ])('flattens %s output', (_name, output, expectedContent, expectedIsError) => {
      const r = row({
        seq: 7,
        message: {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'bash', output }],
        },
      })
      const block = mapGrokMessageRow(r)?.blocks[0]
      expect(block).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_1',
        content: expectedContent,
      })
      if (expectedIsError) expect(block).toMatchObject({ isError: true })
      else expect((block as { isError?: boolean })?.isError).toBeUndefined()
    })
  })

  it('skips a system message entirely', () => {
    const r = row({ seq: 8, message: { role: 'system', content: 'you are a helpful assistant' } })
    expect(mapGrokMessageRow(r)).toBeNull()
  })

  it('skips reasoning parts, leniently', () => {
    const r = row({
      seq: 9,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking...' }] },
    })
    expect(mapGrokMessageRow(r)).toBeNull()
  })

  it('skips image parts, leniently', () => {
    const r = row({
      seq: 10,
      message: { role: 'user', content: [{ type: 'image', image: 'base64...' }] },
    })
    expect(mapGrokMessageRow(r)).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const r: GrokMessageRow = {
      session_id: 'ses_1',
      seq: 11,
      role: 'user',
      message_json: '{not valid json',
      created_at: '2026-07-19T10:00:00.000Z',
    }
    expect(mapGrokMessageRow(r)).toBeNull()
  })

  it('returns null for an unparseable created_at rather than emitting NaN', () => {
    const r = row({ seq: 12, message: { role: 'user', content: 'hi' }, created_at: 'not-a-date' })
    expect(mapGrokMessageRow(r)).toBeNull()
  })

  it('returns null when blocks come out empty', () => {
    const r = row({ seq: 13, message: { role: 'assistant', content: [] } })
    expect(mapGrokMessageRow(r)).toBeNull()
  })
})

describe('parseGrokMessages', () => {
  it('orders output by input row order (caller sorts by seq)', () => {
    const rows: GrokMessageRow[] = [
      row({ seq: 1, message: { role: 'user', content: 'go' } }),
      row({
        seq: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'bash' }],
        },
      }),
      row({
        seq: 3,
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'bash',
              output: { type: 'text', value: 'ok' },
            },
          ],
        },
      }),
      row({ seq: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    ]
    expect(parseGrokMessages(rows).map((m) => m.uuid)).toEqual([
      'ses_1:1',
      'ses_1:2',
      'ses_1:3',
      'ses_1:4',
    ])
  })

  it('skips malformed rows without failing the rest', () => {
    const rows: GrokMessageRow[] = [
      row({ seq: 1, message: { role: 'user', content: 'hi' } }),
      {
        session_id: 'ses_1',
        seq: 2,
        role: 'user',
        message_json: '{bad',
        created_at: '2026-07-19T10:00:00.000Z',
      },
      row({ seq: 3, message: { role: 'assistant', content: 'reply' } }),
    ]
    expect(parseGrokMessages(rows).map((m) => m.uuid)).toEqual(['ses_1:1', 'ses_1:3'])
  })

  it('returns [] for an empty row list', () => {
    expect(parseGrokMessages([])).toEqual([])
  })
})
