import { describe, it, expect } from 'vitest'
import {
  mergeChatMessages,
  buildChatView,
  buildSubagentGroups,
  mainlineStats,
  summarizeTool,
  chatEmptyState,
  toolEditHunks,
  toolWriteHunks,
  toolTodos,
  type ChatActivityRun,
  type ChatImageItem,
} from './chat.js'
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

function thinkingMsg(
  uuid: string,
  role: 'user' | 'assistant',
  text: string,
  ts: number,
): SessionChatMessageDTO {
  return { uuid, role, ts, blocks: [{ type: 'thinking', text }] }
}

function imageMsg(
  uuid: string,
  role: 'user' | 'assistant',
  data: string,
  ts: number,
  mediaType?: string,
): SessionChatMessageDTO {
  return { uuid, role, ts, blocks: [{ type: 'image', data, mediaType }] }
}

function sidechainTextMsg(
  uuid: string,
  role: 'user' | 'assistant',
  text: string,
  ts: number,
  parentUuid?: string,
): SessionChatMessageDTO {
  return { uuid, role, ts, blocks: [{ type: 'text', text }], isSidechain: true, parentUuid }
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

// ─── mainlineStats ──────────────────────────────────────────────────────
// Regression coverage (TASK-N6X4R): pageChatMessages applies `limit` to
// main-thread messages only, then carries associated sidechain messages
// along on top — a fetched page's raw `.length` and `[0].ts` are therefore
// unreliable pagination signals. ChatView.svelte's loadInitial/loadOlder must
// use this helper instead of counting/indexing the raw messages array.

describe('mainlineStats', () => {
  it('counts only main-thread messages, ignoring sidechain messages riding along', () => {
    const messages = [
      textMsg('m1', 'assistant', 'main one', 1),
      sidechainTextMsg('s1', 'assistant', 'side one', 2, 'tu1'),
      sidechainTextMsg('s2', 'assistant', 'side two', 3, 'tu1'),
      textMsg('m2', 'user', 'main two', 4),
    ]
    expect(mainlineStats(messages).mainCount).toBe(2)
  })

  it('oldestMainTs ignores a sidechain message whose ts precedes every main-thread message', () => {
    // A subagent runs DURING its spawning turn, so its own timestamps can
    // precede that turn's — the earliest entry in the array is a sidechain
    // message here, and must not be picked as the pagination cursor.
    const messages = [
      sidechainTextMsg('s1', 'assistant', 'side, earliest ts', 1, 'tu1'),
      textMsg('m1', 'assistant', 'main, later ts', 5),
      textMsg('m2', 'user', 'main, latest ts', 9),
    ]
    expect(mainlineStats(messages).oldestMainTs).toBe(5)
  })

  it('oldestMainTs is null when the list has no main-thread messages at all', () => {
    const messages = [
      sidechainTextMsg('s1', 'assistant', 'side one', 1, 'tu1'),
      sidechainTextMsg('s2', 'assistant', 'side two', 2, 'tu1'),
    ]
    expect(mainlineStats(messages)).toEqual({ mainCount: 0, oldestMainTs: null })
  })

  it('handles an empty list', () => {
    expect(mainlineStats([])).toEqual({ mainCount: 0, oldestMainTs: null })
  })

  it('a page of all main-thread messages (no sidechains) behaves as before', () => {
    const messages = [textMsg('m1', 'assistant', 'a', 1), textMsg('m2', 'user', 'b', 2)]
    expect(mainlineStats(messages)).toEqual({ mainCount: 2, oldestMainTs: 1 })
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

  // ── thinking blocks (TASK-N6X4R bug #1) ─────────────────────────────────

  it('a thinking-only assistant message produces one ChatThinkingItem', () => {
    const items = buildChatView([thinkingMsg('m1', 'assistant', 'pondering...', 1)])
    expect(items).toEqual([
      {
        kind: 'thinking',
        turnId: 'm1',
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        text: 'pondering...',
      },
    ])
  })

  it('a thinking block closes a preceding open activity run', () => {
    const messages: SessionChatMessageDTO[] = [
      {
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        blocks: [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'thinking', text: 'hmm' },
        ],
      },
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('activity')
    expect((items[0] as ChatActivityRun).items).toHaveLength(1)
    expect(items[1].kind).toBe('thinking')
  })

  it('a thinking block followed by a tool_use starts a fresh run (thinking does not merge into it)', () => {
    const messages: SessionChatMessageDTO[] = [
      {
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        blocks: [
          { type: 'thinking', text: 'hmm' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('thinking')
    expect(items[1].kind).toBe('activity')
  })

  it('two thinking blocks separated by a tool_use each close their own boundary', () => {
    const messages: SessionChatMessageDTO[] = [
      {
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        blocks: [
          { type: 'thinking', text: 'first' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'thinking', text: 'second' },
        ],
      },
    ]
    const items = buildChatView(messages)
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'activity', 'thinking'])
  })

  // ── image blocks (TASK-N6X4R bug #1) ────────────────────────────────────

  it('an image-only message produces one ChatImageItem, mediaType passed through', () => {
    const items = buildChatView([imageMsg('m1', 'user', 'YWJj', 1, 'image/jpeg')])
    expect(items).toEqual([
      {
        kind: 'image',
        turnId: 'm1',
        uuid: 'm1',
        role: 'user',
        ts: 1,
        mediaType: 'image/jpeg',
        data: 'YWJj',
      },
    ])
  })

  it('an image block with no mediaType defaults to image/png', () => {
    const items = buildChatView([imageMsg('m1', 'user', 'YWJj', 1)])
    expect((items[0] as ChatImageItem).mediaType).toBe('image/png')
  })

  it('an image block closes a preceding open activity run', () => {
    const messages: SessionChatMessageDTO[] = [
      {
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        blocks: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
          { type: 'image', data: 'YWJj' },
        ],
      },
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('activity')
    expect(items[1].kind).toBe('image')
  })

  // ── sidechain filtering (TASK-N6X4R Task 3) ─────────────────────────────

  it('sidechain messages are excluded from the main flattened flow', () => {
    const messages = [
      textMsg('m1', 'assistant', 'main reply', 1),
      sidechainTextMsg('m2', 'assistant', 'subagent chatter', 2, 'tu1'),
    ]
    const items = buildChatView(messages)
    expect(items).toEqual([
      { kind: 'text', turnId: 'm1', uuid: 'm1', role: 'assistant', ts: 1, text: 'main reply' },
    ])
  })

  it('a sidechain tool_use/tool_result pair does not leak into the main flow or its result map', () => {
    const messages = [
      toolUseMsg('m1', 'tu-main', 'Read', {}, 1),
      sidechainTextMsg('m2', 'assistant', 'side', 2, 'tu-main'),
    ]
    const items = buildChatView(messages)
    expect(items).toHaveLength(1)
    const run = items[0] as ChatActivityRun
    expect(run.items).toHaveLength(1)
    expect(run.items[0].toolUseId).toBe('tu-main')
  })

  it('messages with isSidechain explicitly false are unaffected (backward compatible)', () => {
    const messages: SessionChatMessageDTO[] = [
      {
        uuid: 'm1',
        role: 'assistant',
        ts: 1,
        blocks: [{ type: 'text', text: 'x' }],
        isSidechain: false,
      },
    ]
    expect(buildChatView(messages)).toHaveLength(1)
  })
})

// ─── buildSubagentGroups ────────────────────────────────────────────────

describe('buildSubagentGroups', () => {
  it('returns empty byToolUseId and orphaned for no sidechain messages', () => {
    const messages = [textMsg('m1', 'assistant', 'hi', 1)]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    expect(result.byToolUseId.size).toBe(0)
    expect(result.orphaned).toEqual([])
  })

  it('returns empty for a totally empty input', () => {
    const result = buildSubagentGroups([], [])
    expect(result.byToolUseId.size).toBe(0)
    expect(result.orphaned).toEqual([])
  })

  it('attaches a sidechain group whose parentUuid matches a tool_use id present in items', () => {
    const messages = [
      toolUseMsg('m1', 'tu-agent', 'Agent', { description: 'do work' }, 1),
      sidechainTextMsg('m2', 'assistant', 'subagent turn one', 2, 'tu-agent'),
    ]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    expect(result.orphaned).toEqual([])
    expect(result.byToolUseId.size).toBe(1)
    const group = result.byToolUseId.get('tu-agent')
    expect(group).toBeDefined()
    expect(group!.parentUuid).toBe('tu-agent')
    expect(group!.items).toHaveLength(1)
    expect(group!.items[0]).toMatchObject({ kind: 'text', text: 'subagent turn one' })
    expect(group!.turnCount).toBe(1)
  })

  it('multiple sidechain messages in one group produce a multi-item nested view', () => {
    const messages = [
      toolUseMsg('m1', 'tu-agent', 'Agent', {}, 1),
      sidechainTextMsg('m2', 'assistant', 'nested reply', 2, 'tu-agent'),
      {
        uuid: 'm3',
        role: 'assistant' as const,
        ts: 3,
        blocks: [{ type: 'tool_use' as const, id: 'nested-tu', name: 'Read', input: {} }],
        isSidechain: true,
        parentUuid: 'tu-agent',
      },
    ]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    const group = result.byToolUseId.get('tu-agent')
    expect(group!.items).toHaveLength(2)
    expect(group!.turnCount).toBe(2)
    expect(group!.items[0].kind).toBe('text')
    expect(group!.items[1].kind).toBe('activity')
  })

  it('orphans a sidechain group whose parentUuid does not match any tool_use in items', () => {
    const messages = [
      toolUseMsg('m1', 'tu-agent', 'Agent', {}, 1),
      sidechainTextMsg('m2', 'assistant', 'orphan turn', 2, 'tu-does-not-exist'),
    ]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    expect(result.byToolUseId.size).toBe(0)
    expect(result.orphaned).toHaveLength(1)
    expect(result.orphaned[0].parentUuid).toBe('tu-does-not-exist')
    expect(result.orphaned[0].items).toHaveLength(1)
  })

  it('orphans a sidechain group with no parentUuid at all, rather than dropping it', () => {
    const messages = [sidechainTextMsg('m1', 'assistant', 'no parent', 1, undefined)]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    expect(result.byToolUseId.size).toBe(0)
    expect(result.orphaned).toHaveLength(1)
    expect(result.orphaned[0].parentUuid).toBeUndefined()
    expect(result.orphaned[0].items).toHaveLength(1)
  })

  it('groups multiple orphaned sidechain messages with no parentUuid into ONE orphaned bucket', () => {
    const messages = [
      sidechainTextMsg('m1', 'assistant', 'first', 1, undefined),
      sidechainTextMsg('m2', 'assistant', 'second', 2, undefined),
    ]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    expect(result.orphaned).toHaveLength(1)
    expect(result.orphaned[0].items).toHaveLength(2)
  })

  it('keeps separate attached groups for two different Agent tool_use ids', () => {
    const messages = [
      toolUseMsg('m1', 'tu-a', 'Agent', {}, 1),
      toolUseMsg('m2', 'tu-b', 'Agent', {}, 2),
      sidechainTextMsg('m3', 'assistant', 'a-side', 3, 'tu-a'),
      sidechainTextMsg('m4', 'assistant', 'b-side', 4, 'tu-b'),
    ]
    const items = buildChatView(messages)
    const result = buildSubagentGroups(messages, items)
    expect(result.byToolUseId.size).toBe(2)
    expect(result.byToolUseId.get('tu-a')!.items[0]).toMatchObject({ text: 'a-side' })
    expect(result.byToolUseId.get('tu-b')!.items[0]).toMatchObject({ text: 'b-side' })
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

  // ── TASK-N6X4R Task 4: tools confirmed against real ~/.claude transcripts ──

  it('Agent uses description when present', () => {
    expect(
      summarizeTool('Agent', { description: 'Write CI release pipeline', prompt: 'long...' }),
    ).toBe('Delegated to subagent: Write CI release pipeline')
  })

  it('Agent falls back to prompt when description is missing', () => {
    expect(summarizeTool('Agent', { prompt: 'do the subtask' })).toBe(
      'Delegated to subagent: do the subtask',
    )
  })

  it('Agent falls back to the default summary when neither description nor prompt is present', () => {
    expect(summarizeTool('Agent', { subagent_type: 'general-purpose' })).toBe('Used Agent')
  })

  it('ToolSearch -> Searched tools for "<query>"', () => {
    expect(summarizeTool('ToolSearch', { query: 'select:Read,Edit', max_results: 5 })).toBe(
      'Searched tools for "select:Read,Edit"',
    )
  })

  it('ToolSearch falls back when query is missing', () => {
    expect(summarizeTool('ToolSearch', { max_results: 5 })).toBe('Used ToolSearch')
  })

  it('Skill -> Invoked skill: <skill>', () => {
    expect(summarizeTool('Skill', { skill: 'artifact-design' })).toBe(
      'Invoked skill: artifact-design',
    )
  })

  it('Skill falls back when skill field is missing', () => {
    expect(summarizeTool('Skill', { args: 'foo' })).toBe('Used Skill')
  })

  it('AskUserQuestion uses the first question header', () => {
    expect(
      summarizeTool('AskUserQuestion', {
        questions: [
          { header: 'Tenancy', question: 'Who is this for?', options: [], multiSelect: false },
        ],
      }),
    ).toBe('Asked: Tenancy')
  })

  it('AskUserQuestion falls back to the full question when header is missing', () => {
    expect(
      summarizeTool('AskUserQuestion', {
        questions: [{ question: 'Who is this for?', options: [], multiSelect: false }],
      }),
    ).toBe('Asked: Who is this for?')
  })

  it('AskUserQuestion falls back to default when questions is an empty array', () => {
    expect(summarizeTool('AskUserQuestion', { questions: [] })).toBe('Used AskUserQuestion')
  })

  it('AskUserQuestion falls back to default when questions is missing or malformed', () => {
    expect(summarizeTool('AskUserQuestion', {})).toBe('Used AskUserQuestion')
    expect(summarizeTool('AskUserQuestion', { questions: 'not an array' })).toBe(
      'Used AskUserQuestion',
    )
    expect(summarizeTool('AskUserQuestion', { questions: ['not an object'] })).toBe(
      'Used AskUserQuestion',
    )
    expect(summarizeTool('AskUserQuestion', { questions: [{ header: 42 }] })).toBe(
      'Used AskUserQuestion',
    )
  })

  it('TaskCreate -> Added task: <subject>', () => {
    expect(summarizeTool('TaskCreate', { subject: 'Add interrupted status' })).toBe(
      'Added task: Add interrupted status',
    )
  })

  it('TaskCreate falls back to description when subject is missing', () => {
    expect(summarizeTool('TaskCreate', { description: 'do the thing' })).toBe(
      'Added task: do the thing',
    )
  })

  it('TaskCreate falls back to default when neither subject nor description is present', () => {
    expect(summarizeTool('TaskCreate', { activeForm: 'Doing it' })).toBe('Used TaskCreate')
  })

  it('TaskUpdate uses taskId (camelCase) when present', () => {
    expect(summarizeTool('TaskUpdate', { taskId: '3', status: 'completed' })).toBe(
      'Marked task 3 as completed',
    )
  })

  it('TaskUpdate uses task_id (snake_case) when present — both forms occur in real data', () => {
    expect(summarizeTool('TaskUpdate', { task_id: '1', status: 'completed' })).toBe(
      'Marked task 1 as completed',
    )
  })

  it('TaskUpdate falls back to status-only when neither id form is present', () => {
    expect(summarizeTool('TaskUpdate', { status: 'in_progress' })).toBe(
      'Marked task as in_progress',
    )
  })

  it('TaskUpdate falls back to default when status is missing or wrong-typed', () => {
    expect(summarizeTool('TaskUpdate', { taskId: '1' })).toBe('Used TaskUpdate')
    expect(summarizeTool('TaskUpdate', { taskId: '1', status: 42 })).toBe('Used TaskUpdate')
  })

  it('SendMessage -> Sent <to>: <summary>', () => {
    expect(
      summarizeTool('SendMessage', {
        to: 'agent-123',
        summary: 'Finish README edits',
        message: 'long body...',
      }),
    ).toBe('Sent agent-123: Finish README edits')
  })

  it('SendMessage falls back when to or summary is missing', () => {
    expect(summarizeTool('SendMessage', { message: 'body' })).toBe('Used SendMessage')
    expect(summarizeTool('SendMessage', { to: 'x', message: 'body' })).toBe('Used SendMessage')
  })

  it('a generic mcp__<server>__<tool> name is parsed into "<server>: <tool>"', () => {
    expect(summarizeTool('mcp__slipstream__report_status', {})).toBe('slipstream: report_status')
    expect(summarizeTool('mcp__linear__save_issue', {})).toBe('linear: save_issue')
  })

  it('an mcp-shaped name that does not split into exactly 3 parts falls back to Used <name>', () => {
    expect(summarizeTool('mcp__too__many__parts', {})).toBe('Used mcp__too__many__parts')
    expect(summarizeTool('mcp__onlyserver', {})).toBe('Used mcp__onlyserver')
  })
})

// ─── chatEmptyState ─────────────────────────────────────────────────────

describe('chatEmptyState', () => {
  it('supportsChat:false always reads as unsupported, regardless of available/hasMessages', () => {
    expect(chatEmptyState(false, true, true)).toBe('unsupported')
    expect(chatEmptyState(false, true, false)).toBe('unsupported')
    expect(chatEmptyState(false, false, true)).toBe('unsupported')
    expect(chatEmptyState(false, false, false)).toBe('unsupported')
  })

  it('supportsChat:true, available:false reads as waiting (not unsupported, not empty)', () => {
    expect(chatEmptyState(true, false, false)).toBe('waiting')
    expect(chatEmptyState(true, false, true)).toBe('waiting')
  })

  it('supportsChat:true, available:true, no messages yet reads as empty', () => {
    expect(chatEmptyState(true, true, false)).toBe('empty')
  })

  it('supportsChat:true, available:true, messages present renders the transcript (null)', () => {
    expect(chatEmptyState(true, true, true)).toBeNull()
  })
})

// ─── toolEditHunks ──────────────────────────────────────────────────────

describe('toolEditHunks', () => {
  it('renders old_string as deletions and new_string as additions in one hunk', () => {
    const hunks = toolEditHunks({ old_string: 'a\nb', new_string: 'x\ny\nz', file_path: '/f.ts' })
    expect(hunks).toHaveLength(1)
    const hunk = hunks![0]
    expect(hunk.header).toBe('@@ Edit @@')
    expect(hunk.lines).toEqual([
      { kind: 'del', text: 'a', oldLine: 1, newLine: null },
      { kind: 'del', text: 'b', oldLine: 2, newLine: null },
      { kind: 'add', text: 'x', oldLine: null, newLine: 1 },
      { kind: 'add', text: 'y', oldLine: null, newLine: 2 },
      { kind: 'add', text: 'z', oldLine: null, newLine: 3 },
    ])
  })

  it('handles single-line old_string/new_string with no embedded newline', () => {
    const hunks = toolEditHunks({ old_string: 'foo', new_string: 'bar' })
    expect(hunks![0].lines).toEqual([
      { kind: 'del', text: 'foo', oldLine: 1, newLine: null },
      { kind: 'add', text: 'bar', oldLine: null, newLine: 1 },
    ])
  })

  it('a single trailing newline does not produce a spurious empty final line', () => {
    const hunks = toolEditHunks({ old_string: 'a\n', new_string: 'b\n' })
    expect(hunks![0].lines).toEqual([
      { kind: 'del', text: 'a', oldLine: 1, newLine: null },
      { kind: 'add', text: 'b', oldLine: null, newLine: 1 },
    ])
  })

  it('returns null when old_string is missing', () => {
    expect(toolEditHunks({ new_string: 'x' })).toBeNull()
  })

  it('returns null when new_string is missing', () => {
    expect(toolEditHunks({ old_string: 'x' })).toBeNull()
  })

  it('returns null when a field is wrong-typed', () => {
    expect(toolEditHunks({ old_string: 1, new_string: 'x' })).toBeNull()
  })

  it('never throws on null or non-object input', () => {
    expect(() => toolEditHunks(null)).not.toThrow()
    expect(toolEditHunks(null)).toBeNull()
    expect(() => toolEditHunks('not an object')).not.toThrow()
    expect(toolEditHunks('not an object')).toBeNull()
  })
})

// ─── toolWriteHunks ─────────────────────────────────────────────────────

describe('toolWriteHunks', () => {
  it('renders content as pure additions', () => {
    const hunks = toolWriteHunks({ content: 'line1\nline2', file_path: '/f.ts' })
    expect(hunks).toHaveLength(1)
    expect(hunks![0].header).toBe('@@ Write @@')
    expect(hunks![0].lines).toEqual([
      { kind: 'add', text: 'line1', oldLine: null, newLine: 1 },
      { kind: 'add', text: 'line2', oldLine: null, newLine: 2 },
    ])
  })

  it('an empty content string still produces one (empty) line, not zero hunks', () => {
    const hunks = toolWriteHunks({ content: '' })
    expect(hunks).toHaveLength(1)
    expect(hunks![0].lines).toEqual([{ kind: 'add', text: '', oldLine: null, newLine: 1 }])
  })

  it('returns null when content is missing', () => {
    expect(toolWriteHunks({ file_path: '/f.ts' })).toBeNull()
  })

  it('returns null when content is wrong-typed', () => {
    expect(toolWriteHunks({ content: 42 })).toBeNull()
  })

  it('never throws on null or non-object input', () => {
    expect(() => toolWriteHunks(null)).not.toThrow()
    expect(toolWriteHunks(null)).toBeNull()
    expect(() => toolWriteHunks(123)).not.toThrow()
    expect(toolWriteHunks(123)).toBeNull()
  })
})

// ─── toolTodos ──────────────────────────────────────────────────────────

describe('toolTodos', () => {
  it('parses a well-formed todos array', () => {
    const todos = toolTodos({
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'pending' },
      ],
    })
    expect(todos).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
      { content: 'third', status: 'pending' },
    ])
  })

  it('tolerates an extra activeForm field (present in the real schema, unused here)', () => {
    const todos = toolTodos({
      todos: [{ content: 'first', status: 'pending', activeForm: 'Doing first' }],
    })
    expect(todos).toEqual([{ content: 'first', status: 'pending' }])
  })

  it('skips a malformed item (bad status) but keeps the rest of the array', () => {
    const todos = toolTodos({
      todos: [
        { content: 'good', status: 'pending' },
        { content: 'bad status', status: 'unknown' },
      ],
    })
    expect(todos).toEqual([{ content: 'good', status: 'pending' }])
  })

  it('skips a malformed item (missing content) but keeps the rest of the array', () => {
    const todos = toolTodos({
      todos: [{ status: 'pending' }, { content: 'good', status: 'done' as unknown as string }],
    })
    // both malformed here: first has no content, second has an invalid status
    expect(todos).toBeNull()
  })

  it('skips an item with an empty-string content', () => {
    const todos = toolTodos({ todos: [{ content: '', status: 'pending' }] })
    expect(todos).toBeNull()
  })

  it('skips a non-object item in the array', () => {
    const todos = toolTodos({ todos: ['not an object', { content: 'good', status: 'pending' }] })
    expect(todos).toEqual([{ content: 'good', status: 'pending' }])
  })

  it('returns null when todos is missing', () => {
    expect(toolTodos({})).toBeNull()
  })

  it('returns null when todos is not an array', () => {
    expect(toolTodos({ todos: 'not an array' })).toBeNull()
  })

  it('returns null when todos is an empty array', () => {
    expect(toolTodos({ todos: [] })).toBeNull()
  })

  it('returns null when every item is malformed', () => {
    expect(toolTodos({ todos: [{ content: 'x', status: 'bogus' }] })).toBeNull()
  })

  it('never throws on null or non-object input', () => {
    expect(() => toolTodos(null)).not.toThrow()
    expect(toolTodos(null)).toBeNull()
    expect(() => toolTodos('not an object')).not.toThrow()
    expect(toolTodos('not an object')).toBeNull()
  })
})
