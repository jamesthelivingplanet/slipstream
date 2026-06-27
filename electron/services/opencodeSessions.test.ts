import { describe, it, expect } from 'vitest'
import { selectNewestSessionSince, opencodeStatusFromText, opencodeStatusFromMessages, withOpencodePromptArg } from './opencodeSessions.js'
import type { OpencodeSession, OpencodeMessage } from './opencodeSessions.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

// ── selectNewestSessionSince ─────────────────────────────────────────────────

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
    const sessions: OpencodeSession[] = [
      { id: 'ses_exact', time_created: 1000 },
    ]
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
    expect(withOpencodePromptArg(['--port', '4096'], 'Begin implementing FLO-38.'))
      .toEqual(['--port', '4096', '--prompt', 'Begin implementing FLO-38.'])
  })

  it('returns args unchanged when prompt is null (resume/continue path)', () => {
    const args = ['--continue']
    expect(withOpencodePromptArg(args, null)).toBe(args)
  })

  it('returns args unchanged when prompt is undefined', () => {
    expect(withOpencodePromptArg(['--port', '1'], undefined))
      .toEqual(['--port', '1'])
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
