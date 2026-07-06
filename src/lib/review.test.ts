import { describe, it, expect } from 'vitest'
import { composeReviewPrompt, frameForPty, type ReviewComment } from './review.js'

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    file: 'src/foo.ts',
    side: 'new',
    line: 10,
    lineText: 'const x = 1',
    text: 'Use a const enum here.',
    ...overrides,
  }
}

describe('composeReviewPrompt', () => {
  it('includes the header with the base branch', () => {
    const prompt = composeReviewPrompt([makeComment()], 'main')
    expect(prompt).toContain(
      'Please address the following review comments on your current changes (line numbers refer to the diff vs main):',
    )
  })

  it('formats a single comment with numbering, file:line, quoted line, and text', () => {
    const prompt = composeReviewPrompt([makeComment()], 'main')
    expect(prompt).toContain('1. src/foo.ts:10')
    expect(prompt).toContain('   > const x = 1')
    expect(prompt).toContain('   Use a const enum here.')
  })

  it('appends "(removed line)" for old-side comments', () => {
    const prompt = composeReviewPrompt(
      [makeComment({ side: 'old', line: 5, lineText: 'const y = 2' })],
      'main',
    )
    expect(prompt).toContain('1. src/foo.ts:5 (removed line)')
  })

  it('does not append the suffix for new-side comments', () => {
    const prompt = composeReviewPrompt([makeComment({ side: 'new' })], 'main')
    expect(prompt).not.toContain('(removed line)')
  })

  it('indents multi-line comment text on every line', () => {
    const prompt = composeReviewPrompt(
      [makeComment({ text: 'Line one.\nLine two.\nLine three.' })],
      'main',
    )
    expect(prompt).toContain('   Line one.')
    expect(prompt).toContain('   Line two.')
    expect(prompt).toContain('   Line three.')
  })

  it('groups entries by file in file-first-seen order, not alphabetical', () => {
    const comments = [
      makeComment({ id: 'a', file: 'b.ts', line: 1 }),
      makeComment({ id: 'b', file: 'a.ts', line: 1 }),
      makeComment({ id: 'c', file: 'b.ts', line: 2 }),
    ]
    const prompt = composeReviewPrompt(comments, 'main')
    const bIdx = prompt.indexOf('b.ts:1')
    const b2Idx = prompt.indexOf('b.ts:2')
    const aIdx = prompt.indexOf('a.ts:1')
    expect(bIdx).toBeGreaterThan(-1)
    // Both b.ts entries stay grouped together (ordered by line within the file)...
    expect(b2Idx).toBeGreaterThan(bIdx)
    // ...before a.ts, since b.ts had the first comment overall.
    expect(aIdx).toBeGreaterThan(b2Idx)
  })

  it('orders comments within a file by line number, not insertion order', () => {
    const comments = [
      makeComment({ id: 'a', file: 'x.ts', line: 20 }),
      makeComment({ id: 'b', file: 'x.ts', line: 5 }),
    ]
    const prompt = composeReviewPrompt(comments, 'main')
    const idx5 = prompt.indexOf('x.ts:5')
    const idx20 = prompt.indexOf('x.ts:20')
    expect(idx5).toBeGreaterThan(-1)
    expect(idx20).toBeGreaterThan(idx5)
  })

  it('numbers entries sequentially across files', () => {
    const comments = [
      makeComment({ id: 'a', file: 'a.ts', line: 1 }),
      makeComment({ id: 'b', file: 'b.ts', line: 1 }),
    ]
    const prompt = composeReviewPrompt(comments, 'main')
    expect(prompt).toContain('1. a.ts:1')
    expect(prompt).toContain('2. b.ts:1')
  })

  it('returns just the header for an empty comment list', () => {
    const prompt = composeReviewPrompt([], 'main')
    expect(prompt).toBe(
      'Please address the following review comments on your current changes (line numbers refer to the diff vs main):',
    )
  })
})

describe('frameForPty', () => {
  it('wraps the prompt in bracketed-paste markers and provides a bare CR submit', () => {
    const { paste, submit } = frameForPty('hello')
    expect(paste).toBe('\x1b[200~hello\x1b[201~')
    expect(submit).toBe('\r')
  })
})
