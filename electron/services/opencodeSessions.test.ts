import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  selectNewestSessionSince,
  parseOpencodeSessionIdFromStdout,
  captureOpencodeSessionId,
  queryOpencodeSessionIdFromCli,
  opencodeStatusFromText,
  opencodeStatusFromMessages,
  withOpencodePromptArg,
  opencodeMessageToChat,
  opencodeMessagesToChat,
} from './opencodeSessions.js'
import type { OpencodeSession, OpencodeMessage } from './opencodeSessions.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

// captureOpencodeSessionId / queryOpencodeSessionIdFromCli are thin wrappers
// around execFile + parseOpencodeSessionIdFromStdout. The parse logic itself
// is covered by parseOpencodeSessionIdFromStdout above; to drive the real
// execFile→parse path without depending on opencode being installed (the old
// smoke test was a tautology that always passed), these tests stand up a stub
// binary. queryOpencodeSessionIdFromCli calls execFile(bin,
// ['session','list','--format','json','-n','1']) — argv is fixed, so the stub
// must be a self-contained executable (a node shebang script). Run as CJS
// (extensionless → CommonJS), so the stubs use require, not import.

/** Write an executable shebang script that runs `body` (CJS) to a fresh temp
 *  dir and return its path plus a cleanup thunk. */
function writeFakeBin(body: string): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'slipstream-fake-opencode-'))
  const bin = join(dir, 'fake-opencode')
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(bin, 0o755)
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── parseOpencodeSessionIdFromStdout ────────────────────────────────────────

describe('parseOpencodeSessionIdFromStdout', () => {
  it('returns the id from valid JSON output', () => {
    expect(
      parseOpencodeSessionIdFromStdout(JSON.stringify([{ id: 'ses_abc123', title: 'test' }])),
    ).toBe('ses_abc123')
  })

  it('returns null for empty JSON array', () => {
    expect(parseOpencodeSessionIdFromStdout('[]')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseOpencodeSessionIdFromStdout('not json at all')).toBeNull()
  })

  it('returns null when JSON has no .id field', () => {
    expect(parseOpencodeSessionIdFromStdout('[{"title": "no id"}]')).toBeNull()
  })

  it('trims whitespace before parsing', () => {
    expect(parseOpencodeSessionIdFromStdout('  [{"id": "ses_trim"}]  \n')).toBe('ses_trim')
  })

  it('returns null when id is not a string', () => {
    expect(parseOpencodeSessionIdFromStdout('[{"id": 42}]')).toBeNull()
  })

  it('returns the first entry when multiple sessions exist', () => {
    expect(
      parseOpencodeSessionIdFromStdout(JSON.stringify([{ id: 'ses_first' }, { id: 'ses_second' }])),
    ).toBe('ses_first')
  })
})

// ── queryOpencodeSessionIdFromCli (stub binary) ────────────────────────────

describe('queryOpencodeSessionIdFromCli', () => {
  it('parses the newest session id from the bin stdout', async () => {
    const { bin, cleanup } = writeFakeBin(
      `process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'ses_real123', title: 'x' }]))})`,
    )
    try {
      expect(await queryOpencodeSessionIdFromCli(process.cwd(), bin)).toBe('ses_real123')
    } finally {
      cleanup()
    }
  })

  it('resolves null when the bin emits invalid JSON', async () => {
    const { bin, cleanup } = writeFakeBin(`process.stdout.write('not json at all')`)
    try {
      expect(await queryOpencodeSessionIdFromCli(process.cwd(), bin)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('resolves null when the bin emits an empty session array', async () => {
    const { bin, cleanup } = writeFakeBin(`process.stdout.write('[]')`)
    try {
      expect(await queryOpencodeSessionIdFromCli(process.cwd(), bin)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('resolves null for a nonexistent binary instead of throwing', async () => {
    expect(
      await queryOpencodeSessionIdFromCli(process.cwd(), 'definitely-not-a-real-cli-binary'),
    ).toBeNull()
  })
})

// ── captureOpencodeSessionId (stub binary) ──────────────────────────────────

describe('captureOpencodeSessionId', () => {
  it('returns the id when the bin reports a session on the first attempt', async () => {
    const { bin, cleanup } = writeFakeBin(
      `process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'ses_immediate' }]))})`,
    )
    try {
      expect(
        await captureOpencodeSessionId({ cwd: process.cwd(), bin, attempts: 1, intervalMs: 0 }),
      ).toBe('ses_immediate')
    } finally {
      cleanup()
    }
  })

  it('polls until a session appears within the attempt budget', async () => {
    // First invocation reports no session and drops a marker file; the next
    // invocation sees the marker and reports the session — exercising the
    // retry loop that captureOpencodeSessionId adds over a single query.
    const dir = mkdtempSync(join(tmpdir(), 'slipstream-fake-opencode-'))
    const bin = join(dir, 'fake-opencode')
    const marker = join(dir, 'ready')
    writeFileSync(
      bin,
      '#!/usr/bin/env node\n' +
        `const {existsSync,writeFileSync}=require('node:fs')\n` +
        `const m=${JSON.stringify(marker)}\n` +
        `if(existsSync(m)){process.stdout.write(${JSON.stringify(
          JSON.stringify([{ id: 'ses_polled' }]),
        )})}else{writeFileSync(m,'1');process.stdout.write('[]')}\n`,
    )
    chmodSync(bin, 0o755)
    try {
      expect(
        await captureOpencodeSessionId({ cwd: process.cwd(), bin, attempts: 3, intervalMs: 0 }),
      ).toBe('ses_polled')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives up with null when no session appears within the attempt budget', async () => {
    const { bin, cleanup } = writeFakeBin(`process.stdout.write('[]')`)
    try {
      expect(
        await captureOpencodeSessionId({ cwd: process.cwd(), bin, attempts: 2, intervalMs: 0 }),
      ).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('accepts a "bin" override (a bogus bin resolves to null, never throws)', async () => {
    // Kilo Code reuses this helper with its own resolved binary; a bin that
    // doesn't exist must degrade to null (same as opencode missing) rather
    // than reject.
    expect(
      await captureOpencodeSessionId({
        cwd: process.cwd(),
        attempts: 1,
        intervalMs: 0,
        bin: 'definitely-not-a-real-cli-binary',
      }),
    ).toBeNull()
  })
})

// ── selectNewestSessionSince (kept for potential future use) ──────────────────────

describe('selectNewestSessionSince', () => {
  const sinceMs = 1000

  it('returns null for empty array', () => {
    expect(selectNewestSessionSince([], sinceMs)).toBeNull()
  })

  it('returns null when no session is at or after sinceMs', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_a', time_created: 100 },
      { id: 'ses_b', time_created: 999 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBeNull()
  })

  it('returns the newest among several at or after sinceMs', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_a', time_created: 1000 },
      { id: 'ses_b', time_created: 2000 },
      { id: 'ses_c', time_created: 1500 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_b')
  })

  it('returns the single qualifying session when older ones exist', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_a', time_created: 50 },
      { id: 'ses_b', time_created: 3000 },
      { id: 'ses_c', time_created: 10 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_b')
  })

  it('ignores sessions older than sinceMs regardless of id', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_zzz', time_created: 500 },
      { id: 'ses_aaa', time_created: 5000 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_aaa')
  })

  it('treats a session exactly equal to sinceMs as qualifying', () => {
    const sessions: OpencodeSession[] = [{ id: 'ses_exact', time_created: 1000 }]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_exact')
  })
})

// Helper to build an opencode message with assistant text.
function assistantMsg(...text: string[]): OpencodeMessage {
  return { info: { role: 'assistant' }, parts: text.map((t) => ({ type: 'text', text: t })) }
}
function userMsg(...text: string[]): OpencodeMessage {
  return { info: { role: 'user' }, parts: text.map((t) => ({ type: 'text', text: t })) }
}

// ── opencodeStatusFromText ──────────────────────────────────────────────────

describe('opencodeStatusFromText', () => {
  it('returns "done" when DONE_MARKER is present', () => {
    expect(opencodeStatusFromText(`PR opened.\n${DONE_MARKER}`)).toBe('done')
  })

  it('returns "needs" when NEEDS_INPUT_MARKER is present', () => {
    expect(opencodeStatusFromText(`Which DB?\n${NEEDS_INPUT_MARKER}`)).toBe('needs')
  })

  it('returns "running" when only IN_PROGRESS_MARKER is present', () => {
    expect(opencodeStatusFromText(`Working on it...\n${IN_PROGRESS_MARKER}`)).toBe('running')
  })

  it('defaults to "running" when no marker is present', () => {
    expect(opencodeStatusFromText('Just chatting, no marker here.')).toBe('running')
    expect(opencodeStatusFromText('')).toBe('running')
  })

  it('last marker wins (NEEDS then IN_PROGRESS → running)', () => {
    const text = `${NEEDS_INPUT_MARKER}\nResuming work.\n${IN_PROGRESS_MARKER}`
    expect(opencodeStatusFromText(text)).toBe('running')
  })

  it('last marker wins (IN_PROGRESS then DONE → done)', () => {
    const text = `${IN_PROGRESS_MARKER}\nAll done, PR opened.\n${DONE_MARKER}`
    expect(opencodeStatusFromText(text)).toBe('done')
  })

  it('last marker wins (DONE then NEEDS → needs)', () => {
    const text = `${DONE_MARKER}\nActually I have a question.\n${NEEDS_INPUT_MARKER}`
    expect(opencodeStatusFromText(text)).toBe('needs')
  })
})

// ── opencodeStatusFromMessages ──────────────────────────────────────────────

describe('opencodeStatusFromMessages', () => {
  it('returns "running" for an empty message list', () => {
    expect(opencodeStatusFromMessages([])).toBe('running')
  })

  it('ignores user messages and classifies from assistant text', () => {
    const msgs: OpencodeMessage[] = [
      userMsg('Implement the ticket.'),
      assistantMsg('Opening a PR.', DONE_MARKER),
    ]
    expect(opencodeStatusFromMessages(msgs)).toBe('done')
  })

  it('returns "needs" when the last assistant message ends with NEEDS_INPUT_MARKER', () => {
    const msgs: OpencodeMessage[] = [
      userMsg('go'),
      assistantMsg('Started.', IN_PROGRESS_MARKER),
      assistantMsg('Which framework?', NEEDS_INPUT_MARKER),
    ]
    expect(opencodeStatusFromMessages(msgs)).toBe('needs')
  })

  it('honors the most recent marker across multiple assistant turns', () => {
    const msgs: OpencodeMessage[] = [
      assistantMsg('Waiting on you.', NEEDS_INPUT_MARKER),
      assistantMsg('Thanks, resuming.', IN_PROGRESS_MARKER),
    ]
    expect(opencodeStatusFromMessages(msgs)).toBe('running')
  })

  it('ignores non-text parts', () => {
    const msgs: OpencodeMessage[] = [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: `Done. ${DONE_MARKER}` },
          { type: 'step-finish' },
        ],
      },
    ]
    expect(opencodeStatusFromMessages(msgs)).toBe('done')
  })

  it('returns "running" when only user messages exist (agent has not replied yet)', () => {
    const msgs: OpencodeMessage[] = [userMsg('Begin.')]
    expect(opencodeStatusFromMessages(msgs)).toBe('running')
  })
})

// ── withOpencodePromptArg ────────────────────────────────────────────────────

describe('withOpencodePromptArg', () => {
  it('appends --prompt <prompt> after the base args', () => {
    expect(withOpencodePromptArg(['--port', '4096'], 'Begin implementing FLO-38.')).toEqual([
      '--port',
      '4096',
      '--prompt',
      'Begin implementing FLO-38.',
    ])
  })

  it('returns args unchanged when prompt is null (resume/continue path)', () => {
    const args = ['--continue']
    expect(withOpencodePromptArg(args, null)).toBe(args)
  })

  it('returns args unchanged when prompt is undefined', () => {
    expect(withOpencodePromptArg(['--port', '1'], undefined)).toEqual(['--port', '1'])
  })

  it('returns args unchanged when prompt is empty (blank agent)', () => {
    expect(withOpencodePromptArg(['--port', '1'], '')).toEqual(['--port', '1'])
  })

  it('does not mutate the input args array', () => {
    const args = ['--port', '4096']
    withOpencodePromptArg(args, 'do the thing')
    expect(args).toEqual(['--port', '4096'])
  })

  it('keeps a multi-line prompt intact as a single argv value', () => {
    const prompt = 'Line one\nLine two'
    expect(withOpencodePromptArg([], prompt)).toEqual(['--prompt', prompt])
  })
})

// ── opencodeMessageToChat / opencodeMessagesToChat (TASK-FPH60) ────────────

describe('opencodeMessageToChat', () => {
  it('maps a user text message', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'user', time: { created: 1000 } },
      parts: [{ type: 'text', text: 'hi' }],
    }
    expect(opencodeMessageToChat(msg)).toEqual({
      uuid: 'msg_1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      ts: 1000,
    })
  })

  it('maps an assistant text message', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_2', role: 'assistant', time: { created: 2000 } },
      parts: [{ type: 'text', text: 'hello there' }],
    }
    expect(opencodeMessageToChat(msg)).toEqual({
      uuid: 'msg_2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hello there' }],
      ts: 2000,
    })
  })

  it('defaults ts to 0 when time.created is missing', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'user' },
      parts: [{ type: 'text', text: 'hi' }],
    }
    expect(opencodeMessageToChat(msg)?.ts).toBe(0)
  })

  it('drops an empty text part but keeps other blocks', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [
        { type: 'text', text: '' },
        { type: 'text', text: 'real' },
      ],
    }
    expect(opencodeMessageToChat(msg)?.blocks).toEqual([{ type: 'text', text: 'real' }])
  })

  it('maps a running tool part to just a tool_use block (no result yet)', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [
        {
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'running', input: { command: 'ls' } },
        },
      ],
    }
    expect(opencodeMessageToChat(msg)?.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
    ])
  })

  it('maps a completed tool part to a tool_use + tool_result pair', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [
        {
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt' },
        },
      ],
    }
    expect(opencodeMessageToChat(msg)?.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 'call_1', content: 'file.txt' },
    ])
  })

  it('marks isError:true on an errored tool part and JSON-stringifies a non-string output', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [
        {
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'error', output: { message: 'boom' } },
        },
      ],
    }
    expect(opencodeMessageToChat(msg)?.blocks[1]).toEqual({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: JSON.stringify({ message: 'boom' }),
      isError: true,
    })
  })

  it('falls back to id when callID is absent', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'tool', id: 'part_1', tool: 'bash', state: { status: 'running' } }],
    }
    expect(opencodeMessageToChat(msg)?.blocks).toEqual([
      { type: 'tool_use', id: 'part_1', name: 'bash', input: {} },
    ])
  })

  it('drops a tool part with no id and no tool name', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'tool', state: { status: 'running' } }],
    }
    expect(opencodeMessageToChat(msg)).toBeNull()
  })

  it('ignores unrendered part kinds (reasoning, step-start/finish)', () => {
    const msg: OpencodeMessage = {
      info: { id: 'msg_1', role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'step-start' }, { type: 'text', text: 'ok' }, { type: 'step-finish' }],
    }
    expect(opencodeMessageToChat(msg)?.blocks).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('returns null for a message with no role', () => {
    expect(opencodeMessageToChat({ parts: [{ type: 'text', text: 'hi' }] })).toBeNull()
  })

  it('returns null for a message with no id', () => {
    expect(
      opencodeMessageToChat({ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }),
    ).toBeNull()
  })

  it('returns null when there is nothing renderable', () => {
    const msg: OpencodeMessage = { info: { id: 'msg_1', role: 'assistant' }, parts: [] }
    expect(opencodeMessageToChat(msg)).toBeNull()
  })
})

describe('opencodeMessagesToChat', () => {
  it('maps and filters a list, preserving order', () => {
    const msgs: OpencodeMessage[] = [
      {
        info: { id: 'u1', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'go' }],
      },
      { info: { role: 'assistant' }, parts: [] }, // dropped: no id
      {
        info: { id: 'a1', role: 'assistant', time: { created: 2 } },
        parts: [{ type: 'text', text: 'ok' }],
      },
    ]
    expect(opencodeMessagesToChat(msgs).map((m) => m.uuid)).toEqual(['u1', 'a1'])
  })

  it('returns [] for an empty list', () => {
    expect(opencodeMessagesToChat([])).toEqual([])
  })
})
