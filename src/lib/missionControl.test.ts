import { describe, it, expect } from 'vitest'
import { stripAnsi, extractAsk, formatWait, suggestedReplies } from './missionControl.js'

// ─── stripAnsi ────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes CSI color sequences', () => {
    expect(stripAnsi('\x1B[32mhello\x1B[0m')).toBe('hello')
  })

  it('removes cursor movement sequences', () => {
    expect(stripAnsi('\x1B[2J\x1B[H')).toBe('')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here')
  })
})

// ─── extractAsk ───────────────────────────────────────────────────────────────

describe('extractAsk', () => {
  it('returns null for an empty buffer', () => {
    expect(extractAsk('')).toBeNull()
  })

  it('returns null for a whitespace-only buffer', () => {
    expect(extractAsk('   \n  \n')).toBeNull()
  })

  it('extracts a plain trailing question', () => {
    expect(extractAsk('I found 3 issues.\nShould I fix them all?')).toBe('Should I fix them all?')
  })

  it('extracts a [y/n]-style prompt', () => {
    expect(extractAsk('Remove unused imports?\nRemove unused imports? [y/n]')).toBe(
      'Remove unused imports? [y/n]',
    )
  })

  it('extracts a (y/N) prompt with no trailing question mark', () => {
    expect(extractAsk('Overwrite the file (y/N)')).toBe('Overwrite the file (y/N)')
  })

  it('extracts a [Y/n] prompt', () => {
    expect(extractAsk('Proceed with deploy [Y/n]')).toBe('Proceed with deploy [Y/n]')
  })

  it('extracts a multi-line numbered-menu question block', () => {
    const buf = 'Working on it...\nPick an option:\n1. Deploy now\n2. Cancel'
    expect(extractAsk(buf)).toBe('Pick an option: 1. Deploy now 2. Cancel')
  })

  it('does not extend the menu block past a non-question header', () => {
    // The line before the numbered options is not question-like, so there's
    // no valid header to anchor the block — treat as no question found.
    const buf = 'Some progress log\n1. Deploy now\n2. Cancel'
    expect(extractAsk(buf)).toBeNull()
  })

  it('strips ANSI color codes before matching', () => {
    expect(extractAsk('\x1B[33mShould I\x1B[0m continue?')).toBe('Should I continue?')
  })

  it('collapses internal whitespace and trims', () => {
    expect(extractAsk('Should   I   continue?  ')).toBe('Should I continue?')
  })

  it('ignores trailing blank lines when finding the last line', () => {
    expect(extractAsk('Should I continue?\n\n\n')).toBe('Should I continue?')
  })

  it('returns null for plain non-question output', () => {
    expect(extractAsk('Installing dependencies...\nAdded 42 packages')).toBeNull()
  })

  it('returns null when the tail ends with a colon-less, question-less statement', () => {
    expect(extractAsk('All tests passed')).toBeNull()
  })

  it('only inspects roughly the last 2000 chars of a large buffer', () => {
    const noise = 'x'.repeat(5000)
    expect(extractAsk(`Should I proceed?\n${noise}`)).toBeNull()
  })

  it('still finds the question when it falls within the tail window of a large buffer', () => {
    const noise = 'progress line\n'.repeat(300) // well under 2000 chars of trailing noise once we append the question
    const buf = `${noise}Should I proceed?`
    expect(extractAsk(buf)).toBe('Should I proceed?')
  })

  it('truncates long questions to maxLen with an ellipsis', () => {
    const longQuestion = `Should I ${'really '.repeat(40)}proceed?`
    const result = extractAsk(longQuestion)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(160)
    expect(result!.endsWith('…')).toBe(true)
  })

  it('respects a custom maxLen', () => {
    const question = 'Should I proceed with this very long and detailed plan of action?'
    const result = extractAsk(question, 20)
    expect(result!.length).toBeLessThanOrEqual(20)
    expect(result!.endsWith('…')).toBe(true)
  })

  it('does not truncate when the question fits within maxLen', () => {
    expect(extractAsk('Continue?', 20)).toBe('Continue?')
  })
})

// ─── suggestedReplies ───────────────────────────────────────────────────────────

describe('suggestedReplies', () => {
  it('returns [] for null', () => {
    expect(suggestedReplies(null)).toEqual([])
  })

  it('returns [] for undefined', () => {
    expect(suggestedReplies(undefined)).toEqual([])
  })

  it('returns [] for an empty string', () => {
    expect(suggestedReplies('')).toEqual([])
  })

  it('returns [] for a whitespace-only string', () => {
    expect(suggestedReplies('   ')).toEqual([])
  })

  it('matches a trailing [y/n] prompt', () => {
    expect(suggestedReplies('Remove unused imports? [y/n]')).toEqual(['y', 'n'])
  })

  it('matches a trailing (y/N) prompt and preserves the default-hint casing', () => {
    expect(suggestedReplies('Overwrite the file (y/N)')).toEqual(['y', 'N'])
  })

  it('matches a trailing [Y/n] prompt and preserves the default-hint casing', () => {
    expect(suggestedReplies('Proceed with deploy [Y/n]')).toEqual(['Y', 'n'])
  })

  it('matches a trailing "yes/no?" prompt', () => {
    expect(suggestedReplies('Should I delete this? yes/no?')).toEqual(['y', 'n'])
  })

  it('matches a trailing "proceed?" question', () => {
    expect(suggestedReplies('Should I proceed?')).toEqual(['Yes', 'No'])
  })

  it('matches a trailing "continue?" question', () => {
    expect(suggestedReplies('Continue?')).toEqual(['Yes', 'No'])
  })

  it('matches "shall I proceed" phrasing', () => {
    expect(suggestedReplies('Shall I proceed with the migration?')).toEqual(['Yes', 'No'])
  })

  it('returns [] for an open-ended question', () => {
    expect(suggestedReplies('What should I name this branch?')).toEqual([])
  })

  it('returns [] for a multi-choice menu question', () => {
    expect(suggestedReplies('Pick an option: 1. Deploy now 2. Cancel')).toEqual([])
  })

  it('returns [] for plain non-question text', () => {
    expect(suggestedReplies('Installing dependencies...')).toEqual([])
  })
})

// ─── formatWait ───────────────────────────────────────────────────────────────

describe('formatWait', () => {
  it('returns "<1m" for elapsed under a minute', () => {
    expect(formatWait(0, 0)).toBe('<1m')
    expect(formatWait(0, 59_999)).toBe('<1m')
  })

  it('returns "1m" right at the one-minute boundary', () => {
    expect(formatWait(0, 60_000)).toBe('1m')
  })

  it('returns minutes under an hour', () => {
    expect(formatWait(0, 4 * 60_000)).toBe('4m')
    expect(formatWait(0, 59 * 60_000)).toBe('59m')
  })

  it('returns "1h 0m" right at the one-hour boundary', () => {
    expect(formatWait(0, 60 * 60_000)).toBe('1h 0m')
  })

  it('returns hours and minutes under a day', () => {
    const ms = 60 * 60_000 + 12 * 60_000 // 1h 12m
    expect(formatWait(0, ms)).toBe('1h 12m')
  })

  it('returns "23h 59m" just under the one-day boundary', () => {
    const ms = 24 * 60 * 60_000 - 60_000
    expect(formatWait(0, ms)).toBe('23h 59m')
  })

  it('returns "1d" right at the one-day boundary', () => {
    expect(formatWait(0, 24 * 60 * 60_000)).toBe('1d')
  })

  it('returns days for multi-day elapsed', () => {
    expect(formatWait(0, 2 * 24 * 60 * 60_000)).toBe('2d')
  })

  it('defaults `now` to Date.now() when omitted', () => {
    const since = Date.now() - 5000
    expect(formatWait(since)).toBe('<1m')
  })

  it('clamps negative elapsed (since in the future) to "<1m"', () => {
    expect(formatWait(10_000, 0)).toBe('<1m')
  })
})
