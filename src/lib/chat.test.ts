import { describe, it, expect } from 'vitest'
import { mergeChatMessages, buildChatView, summarizeTool, type ChatActivityRun } from './chat.js'
import type { SessionChatMessageDTO } from '../../electron/shared/contract.js'

// ─── fixtures ───────────────────────────────────────────────────────────

function textMsg(
  uuid: string,
  role: 'user' | 'assistant',
  text: string,
  ts: number,
): SessionChatMessageDTO {
  return { uuid, role, ts, blocks: [{ type: 'text', text }] }
}

function toolUseMsg(
  uuid: string,
  toolUseId: string,
  name: string,
  input: unknown,
  ts: number,
): SessionChatMessageDTO {
  return { uuid, role: 'assistant', ts, blocks: [{ type: 'tool_use', id: toolUseId, name, input }] }
}

function toolResultMsg(
  uuid: string,
  toolUseId: string,
  content: string,
  ts: number,
  isError?: boolean,
): SessionChatMessageDTO {
  return {
    uuid,
    role: 'user',
    ts,
    blocks: [{ type: 'tool_result', toolUseId, content, isError }],
  }
}

// ─── mergeChatMessages ──────────────────────────────────────────────────

describe('mergeChatMessages', () => {
  it('handles both lists empty', () => {
    expect(mergeChatMessages([], [])).toEqual([])
  })

  it('handles empty existing', () => {
    const incoming = [textMsg('a', 'user', 'hi', 1)]
    expect(mergeChatMessages([], incoming)).toEqual(incoming)
  })

  it('handles empty incoming', () => {
    const existing = [textMsg('a', 'user', 'hi', 1)]
    expect(mergeChatMessages(existing, [])).toEqual(existing)
  })

  it('dedupes by uuid, keeping the incoming version on conflict', () => {
    const existing = [textMsg('a', 'user', 'stale', 1)]
    const incoming = [textMsg('a', 'user', 'fresh', 1)]
    const merged = mergeChatMessages(existing, incoming)
    expect(merged).toHaveLength(1)
    expect(merged[0].blocks).toEqual([{ type: 'text', text: 'fresh' }])
  })

  it('sorts ascending by ts', () => {
    const existing = [textMsg('b', 'user', 'second', 20)]
    const incoming = [textMsg('a', 'user', 'first', 10)]
    const merged = mergeChatMessages(existing, incoming)
    expect(merged.map((m) => m.uuid)).toEqual(['a', 'b'])
  })

  it('handles out-of-order input from both sides', () => {
    const existing = [textMsg('c', 'user', 'third', 30), textMsg('a', 'user', 'first', 10)]
    const incoming = [textMsg('d', 'user', 'fourth', 40), textMsg('b', 'user', 'second', 20)]
    const merged = mergeChatMessages(existing, incoming)
    expect(merged.map((m) => m.uuid)).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ─── buildChatView ──────────────────────────────────────────────────────

describe('buildChatView', () => {
  it('a text-only assistant message produces one ChatTextItem', () => {
    const items = buildChatView([textMsg('m1', 'assistant', 'hello', 1)])
    expect(items).toEqual([
      { kind: 'text', turnId: 'm1', uuid: 'm1', role: 'assistant', ts: 1, text: 'hello' },
    ])
  })

  it('a user text message produces a ChatTextItem with role: user', () => {
    const items = buildChatView([textMsg('m1', 'user', 'hi there', 1)])
    expect(items).toEqual([
      { kind: 'text', turnId: 'm1', uuid: 'm1', role: 'user', ts: 1, text: 'hi there' },
    ])
  })

  it('a lone tool_use with no result yet produces a ChatActivityRun with one item, result null', () => {
    const items = buildChatView([toolUseMsg('m1', 'tu1', 'Read', { file_path: '/a.ts' }, 1)])
    expect(items).toHaveLength(1)
    const run = items[0] as ChatActivityRun
    expect(run.kind).toBe('activity')
    expect(run.turnId).toBe('m1')
    expect(run.items).toHaveLength(1)
    expect(run.items[0].result).toBeNull()
    expect(run.items[0].toolUseId).toBe('tu1')
  })

  it('a tool_use whose tool_result arrives as a LATER separate message gets paired', () => {
    const messages = [
      toolUseMsg('m1', 'tu1', 'Bash', { command: 'ls' }, 1),
      toolResultMsg('m2', 'tu1', 'file1\nfile2', 2, true),
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(1)
    const run = items[0] as ChatActivityRun
    expect(run.items).toHaveLength(1)
    expect(run.items[0].result).toEqual({ content: 'file1\nfile2', isError: true })
  })

  it('two tool_use calls separated only by an intervening tool_result collapse into ONE run', () => {
    const messages = [
      toolUseMsg('m1', 'tu1', 'Read', { file_path: '/a.ts' }, 1),
      toolResultMsg('m2', 'tu1', 'contents of a.ts', 2),
      toolUseMsg('m3', 'tu2', 'Read', { file_path: '/b.ts' }, 3),
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(1)
    const run = items[0] as ChatActivityRun
    expect(run.items).toHaveLength(2)
    expect(run.items[0].toolUseId).toBe('tu1')
    expect(run.items[0].result).toEqual({ content: 'contents of a.ts', isError: undefined })
    expect(run.items[1].toolUseId).toBe('tu2')
    expect(run.items[1].result).toBeNull()
    // turnId is the uuid of the message with the FIRST tool_use, not the second
    expect(run.turnId).toBe('m1')
  })

  it('a tool_result with no matching tool_use anywhere is dropped, no crash', () => {
    const messages = [toolResultMsg('m1', 'orphan', 'stray result', 1)]
    const items = buildChatView(messages)
    expect(items).toEqual([])
  })

  it('a text block always splits activity into separate runs', () => {
    // assistant: text, tool_use, text, tool_use -> two separate one-item runs
    const messages: SessionChatMessageDTO[] = [
      {
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        blocks: [
          { type: 'text', text: 'first text' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'text', text: 'second text' },
          { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/b.ts' } },
        ],
      },
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(4)
    expect(items[0].kind).toBe('text')
    expect(items[1].kind).toBe('activity')
    expect((items[1] as ChatActivityRun).items).toHaveLength(1)
    expect((items[1] as ChatActivityRun).items[0].toolUseId).toBe('tu1')
    expect(items[2].kind).toBe('text')
    expect(items[3].kind).toBe('activity')
    expect((items[3] as ChatActivityRun).items).toHaveLength(1)
    expect((items[3] as ChatActivityRun).items[0].toolUseId).toBe('tu2')
  })

  it('turnId on an activity run equals the uuid of the message holding the first tool_use', () => {
    const messages = [
      toolUseMsg('first-msg', 'tu1', 'Read', { file_path: '/a.ts' }, 1),
      toolUseMsg('second-msg', 'tu2', 'Read', { file_path: '/b.ts' }, 2),
      toolUseMsg('third-msg', 'tu3', 'Read', { file_path: '/c.ts' }, 3),
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(1)
    expect((items[0] as ChatActivityRun).turnId).toBe('first-msg')
  })

  it('a result present earlier in the message list still gets paired (order-independent lookup)', () => {
    const messages = [
      toolResultMsg('m1', 'tu1', 'early result', 1),
      toolUseMsg('m2', 'tu1', 'Read', { file_path: '/a.ts' }, 2),
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(1)
    const run = items[0] as ChatActivityRun
    expect(run.items[0].result).toEqual({ content: 'early result', isError: undefined })
  })

  it('handles an empty message list', () => {
    expect(buildChatView([])).toEqual([])
  })
})

// ─── summarizeTool ──────────────────────────────────────────────────────

describe('summarizeTool', () => {
  it('Edit -> Edited <file_path>', () => {
    expect(summarizeTool('Edit', { file_path: '/x/y.ts' })).toBe('Edited /x/y.ts')
  })

  it('Write -> Wrote <file_path>', () => {
    expect(summarizeTool('Write', { file_path: '/x/y.ts' })).toBe('Wrote /x/y.ts')
  })

  it('Read -> Read <file_path>', () => {
    expect(summarizeTool('Read', { file_path: '/x/y.ts' })).toBe('Read /x/y.ts')
  })

  it('Bash uses description when present and non-empty', () => {
    expect(summarizeTool('Bash', { command: 'ls -la', description: 'List files' })).toBe(
      'List files',
    )
  })

  it('Bash falls back to Ran <command> when description is missing', () => {
    expect(summarizeTool('Bash', { command: 'ls -la' })).toBe('Ran ls -la')
  })

  it('Bash falls back to Ran <command> when description is an empty string', () => {
    expect(summarizeTool('Bash', { command: 'ls -la', description: '' })).toBe('Ran ls -la')
  })

  it('Bash truncates a long command to 60 chars with a trailing ellipsis', () => {
    const command = 'a'.repeat(80)
    const result = summarizeTool('Bash', { command })
    // 'Ran ' + 60 chars + '…'
    expect(result).toBe(`Ran ${'a'.repeat(60)}…`)
    expect(result.length).toBe('Ran '.length + 60 + 1)
  })

  it('Bash does not truncate a command at exactly 60 chars', () => {
    const command = 'a'.repeat(60)
    expect(summarizeTool('Bash', { command })).toBe(`Ran ${command}`)
  })

  it('Grep -> Searched for "<pattern>"', () => {
    expect(summarizeTool('Grep', { pattern: 'TODO' })).toBe('Searched for "TODO"')
  })

  it('Glob -> Searched files matching <pattern>', () => {
    expect(summarizeTool('Glob', { pattern: '**/*.ts' })).toBe('Searched files matching **/*.ts')
  })

  it('WebFetch -> Fetched <url>', () => {
    expect(summarizeTool('WebFetch', { url: 'https://example.com' })).toBe(
      'Fetched https://example.com',
    )
  })

  it('WebSearch -> Searched the web for "<query>"', () => {
    expect(summarizeTool('WebSearch', { query: 'weather today' })).toBe(
      'Searched the web for "weather today"',
    )
  })

  it('TodoWrite -> Updated the task list', () => {
    expect(summarizeTool('TodoWrite', { todos: [] })).toBe('Updated the task list')
  })

  it('Task uses description when present', () => {
    expect(summarizeTool('Task', { description: 'Run tests', prompt: 'long prompt...' })).toBe(
      'Delegated: Run tests',
    )
  })

  it('Task falls back to prompt when description is missing', () => {
    expect(summarizeTool('Task', { prompt: 'do the thing' })).toBe('Delegated: do the thing')
  })

  it('Task falls back to the default summary when neither description nor prompt is present', () => {
    expect(summarizeTool('Task', {})).toBe('Used Task')
  })

  it('NotebookEdit -> Edited <notebook_path>', () => {
    expect(summarizeTool('NotebookEdit', { notebook_path: '/nb.ipynb' })).toBe('Edited /nb.ipynb')
  })

  it('a known tool with a missing expected field falls back to Used <name>', () => {
    expect(summarizeTool('Edit', {})).toBe('Used Edit')
    expect(summarizeTool('Grep', {})).toBe('Used Grep')
  })

  it('a known tool with a wrong-typed expected field falls back to Used <name>', () => {
    expect(summarizeTool('Read', { file_path: 42 })).toBe('Used Read')
  })

  it('an unknown tool name falls back to Used <name>', () => {
    expect(summarizeTool('SomeFutureTool', { anything: true })).toBe('Used SomeFutureTool')
  })

  it('never throws on null or non-object input', () => {
    expect(() => summarizeTool('Edit', null)).not.toThrow()
    expect(summarizeTool('Edit', null)).toBe('Used Edit')
    expect(() => summarizeTool('Bash', 'not an object')).not.toThrow()
    expect(summarizeTool('Bash', 'not an object')).toBe('Used Bash')
  })
})
