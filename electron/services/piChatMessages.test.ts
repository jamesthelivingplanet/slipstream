import { describe, it, expect } from 'vitest'
import { parsePiChatMessages } from './piChatMessages.js'

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: '2026-07-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('parsePiChatMessages', () => {
  it('parses a user text message', () => {
    const raw = JSON.stringify(entry({ id: 'u1', message: { role: 'user', content: 'hi' } }))
    expect(parsePiChatMessages(raw)).toEqual([
      {
        uuid: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it('parses an assistant text block array', () => {
    const raw = JSON.stringify(
      entry({
        id: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
      }),
    )
    expect(parsePiChatMessages(raw)).toEqual([
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello there' }],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it('drops thinking-only assistant turns (nothing renderable)', () => {
    const raw = JSON.stringify(
      entry({
        id: 'a1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      }),
    )
    expect(parsePiChatMessages(raw)).toEqual([])
  })

  it('maps a toolCall block to a tool_use ChatBlock, defaulting missing arguments to {}', () => {
    const raw = JSON.stringify(
      entry({
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'bash' }],
        },
      }),
    )
    expect(parsePiChatMessages(raw)).toEqual([
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it('carries toolCall arguments through as tool_use input', () => {
    const raw = JSON.stringify(
      entry({
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } }],
        },
      }),
    )
    const [msg] = parsePiChatMessages(raw)
    expect(msg.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } },
    ])
  })

  it('maps a toolResult entry to a synthetic role:user message with a tool_result block', () => {
    const raw = JSON.stringify(
      entry({
        id: 'tr1',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'output' }],
          isError: false,
        },
      }),
    )
    expect(parsePiChatMessages(raw)).toEqual([
      {
        uuid: 'tr1',
        role: 'user',
        blocks: [{ type: 'tool_result', toolUseId: 'call_1', content: 'output' }],
        ts: Date.parse('2026-07-19T10:00:00.000Z'),
      },
    ])
  })

  it('carries isError:true through on a failed toolResult', () => {
    const raw = JSON.stringify(
      entry({
        id: 'tr1',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        },
      }),
    )
    const [msg] = parsePiChatMessages(raw)
    expect(msg.blocks[0]).toMatchObject({ isError: true })
  })

  it('flattens a multi-part toolResult content array, dropping non-text parts', () => {
    const raw = JSON.stringify(
      entry({
        id: 'tr1',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', data: 'abc' },
            { type: 'text', text: 'line two' },
          ],
        },
      }),
    )
    const [msg] = parsePiChatMessages(raw)
    expect(msg.blocks[0]).toMatchObject({ content: 'line one\nline two' })
  })

  it('treats a plain-string toolResult content as its own text', () => {
    const raw = JSON.stringify(
      entry({
        id: 'tr1',
        message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: 'plain' },
      }),
    )
    const [msg] = parsePiChatMessages(raw)
    expect(msg.blocks[0]).toMatchObject({ content: 'plain' })
  })

  it('ignores the session header line (type !== message)', () => {
    const raw = JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: '/x' })
    expect(parsePiChatMessages(raw)).toEqual([])
  })

  it('skips malformed JSON lines without throwing', () => {
    const good = JSON.stringify(entry({ id: 'u1', message: { role: 'user', content: 'hi' } }))
    const raw = 'not json\n' + good + '\n{"type":"message","id":"a1","message":{"role":"ass'
    expect(parsePiChatMessages(raw).map((m) => m.uuid)).toEqual(['u1'])
  })

  it.each([
    ['missing id', { type: 'message', timestamp: 't', message: { role: 'user', content: 'hi' } }],
    ['missing message', { type: 'message', id: 'm1', timestamp: 't' }],
    [
      'unknown message role',
      {
        type: 'message',
        id: 'm1',
        timestamp: '2026-07-19T10:00:00.000Z',
        message: { role: 'system', content: 'hi' },
      },
    ],
    [
      'toolResult missing toolCallId',
      {
        type: 'message',
        id: 'm1',
        timestamp: '2026-07-19T10:00:00.000Z',
        message: { role: 'toolResult', content: 'x' },
      },
    ],
    ['not an object', '"just a string"'],
  ])('drops a line with %s', (_name, line) => {
    const raw = typeof line === 'string' ? line : JSON.stringify(line)
    expect(parsePiChatMessages(raw)).toEqual([])
  })

  it('skips blank lines', () => {
    expect(parsePiChatMessages('\n\n   \n')).toEqual([])
  })

  it('parses multiple entries in file order', () => {
    const lines = [
      entry({ id: 'u1', message: { role: 'user', content: 'go' } }),
      entry({
        id: 'a1',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }] },
      }),
      entry({
        id: 'tr1',
        message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: 'ok' },
      }),
      entry({
        id: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }),
    ]
    const raw = lines.map((l) => JSON.stringify(l)).join('\n')
    expect(parsePiChatMessages(raw).map((m) => m.uuid)).toEqual(['u1', 'a1', 'tr1', 'a2'])
  })
})
