import { describe, it, expect } from 'vitest'
import {
  piSessionDirName,
  piSessionDirFor,
  selectNewestPiSessionFile,
  piStatusFromText,
  piStatusFromFileContent,
} from './piSessions.js'
import { DONE_MARKER, NEEDS_INPUT_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

describe('piSessionDirName', () => {
  it('encodes cwd by replacing / with - and wrapping in -', () => {
    expect(piSessionDirName('/home/james')).toBe('--home-james-')
  })

  it('encodes a nested worktree path', () => {
    expect(piSessionDirName('/home/james/.worktrees/foo/bar')).toBe('--home-james-.worktrees-foo-bar-')
  })
})

describe('piSessionDirFor', () => {
  it('joins the root with the encoded dir name', () => {
    expect(piSessionDirFor('/home/james', '/tmp/sessions')).toBe('/tmp/sessions/--home-james-')
  })
})

describe('selectNewestPiSessionFile', () => {
  it('returns the file with the highest mtime', () => {
    const files = [
      { file: 'a.jsonl', mtime: 100 },
      { file: 'b.jsonl', mtime: 300 },
      { file: 'c.jsonl', mtime: 200 },
    ]
    expect(selectNewestPiSessionFile(files)).toBe('b.jsonl')
  })

  it('returns null for an empty list', () => {
    expect(selectNewestPiSessionFile([])).toBeNull()
  })
})

describe('piStatusFromText', () => {
  it('defaults to running when no marker is present', () => {
    expect(piStatusFromText('working hard...')).toBe('running')
  })

  it('returns done when DONE_MARKER is present', () => {
    expect(piStatusFromText(`all done ${DONE_MARKER}`)).toBe('done')
  })

  it('returns needs when NEEDS_INPUT_MARKER is present', () => {
    expect(piStatusFromText(`need input ${NEEDS_INPUT_MARKER}`)).toBe('needs')
  })

  it('returns running when only IN_PROGRESS_MARKER is present', () => {
    expect(piStatusFromText(`going ${IN_PROGRESS_MARKER}`)).toBe('running')
  })

  it('last marker wins (NEEDS then IN_PROGRESS → running)', () => {
    expect(piStatusFromText(`${NEEDS_INPUT_MARKER} ${IN_PROGRESS_MARKER}`)).toBe('running')
  })

  it('last marker wins (IN_PROGRESS then DONE → done)', () => {
    expect(piStatusFromText(`${IN_PROGRESS_MARKER} ${DONE_MARKER}`)).toBe('done')
  })
})

describe('piStatusFromFileContent', () => {
  const header = JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: '/x' })

  it('returns running for empty content', () => {
    expect(piStatusFromFileContent('')).toBe('running')
  })

  it('ignores header and user messages', () => {
    const lines = [
      header,
      JSON.stringify({ type: 'message', id: '1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi' } }),
    ]
    expect(piStatusFromFileContent(lines.join('\n'))).toBe('running')
  })

  it('classifies done from assistant text blocks', () => {
    const lines = [
      header,
      JSON.stringify({ type: 'message', id: '2', parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: `finished ${DONE_MARKER}` }] } }),
    ]
    expect(piStatusFromFileContent(lines.join('\n'))).toBe('done')
  })

  it('classifies needs from assistant text', () => {
    const lines = [
      header,
      JSON.stringify({ type: 'message', id: '2', parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: `question? ${NEEDS_INPUT_MARKER}` }] } }),
    ]
    expect(piStatusFromFileContent(lines.join('\n'))).toBe('needs')
  })

  it('ignores non-text content blocks (thinking, toolCall)', () => {
    const lines = [
      header,
      JSON.stringify({ type: 'message', id: '2', parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: `${IN_PROGRESS_MARKER}` }] } }),
    ]
    expect(piStatusFromFileContent(lines.join('\n'))).toBe('running')
  })

  it('honors the most recent marker across multiple assistant turns', () => {
    const lines = [
      header,
      JSON.stringify({ type: 'message', id: '1', parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: DONE_MARKER }] } }),
      JSON.stringify({ type: 'message', id: '2', parentId: '1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: NEEDS_INPUT_MARKER }] } }),
    ]
    expect(piStatusFromFileContent(lines.join('\n'))).toBe('needs')
  })

  it('skips malformed JSON lines', () => {
    const lines = [
      'not json',
      header,
      JSON.stringify({ type: 'message', id: '2', parentId: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: DONE_MARKER }] } }),
    ]
    expect(piStatusFromFileContent(lines.join('\n'))).toBe('done')
  })
})
