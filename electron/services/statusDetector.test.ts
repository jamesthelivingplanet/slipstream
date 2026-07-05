/**
 * StatusDetector unit tests — no real processes, no real timers.
 * All timing is controlled via a fake clock passed to the constructor.
 */

import { describe, it, expect } from 'vitest'
import {
  StatusDetector,
  looksLikeQuestion,
  stripAnsi,
  tailSignal,
  NEEDS_PATTERNS,
} from './statusDetector.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

// ─── Fake clock helpers ───────────────────────────────────────────────────────

function makeClock(initial = 0) {
  let t = initial
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const DEFAULT_IDLE = 4000

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

// ─── looksLikeQuestion ────────────────────────────────────────────────────────

describe('looksLikeQuestion', () => {
  it('matches [y/n] variants', () => {
    expect(looksLikeQuestion('Delete this file? [y/n]')).toBe(true)
    expect(looksLikeQuestion('Are you sure? (y/N)')).toBe(true)
    expect(looksLikeQuestion('Overwrite? [Y/n]')).toBe(true)
  })

  it('matches "Should I"', () => {
    expect(looksLikeQuestion('Should I proceed with the refactor?')).toBe(true)
  })

  it('matches "Do you want"', () => {
    expect(looksLikeQuestion('Do you want me to add tests?')).toBe(true)
  })

  it('matches "Continue?" / "Proceed?"', () => {
    expect(looksLikeQuestion('Continue?')).toBe(true)
    expect(looksLikeQuestion('Proceed?')).toBe(true)
  })

  it('matches trailing ? (with whitespace)', () => {
    expect(looksLikeQuestion('Is this what you meant? ')).toBe(true)
  })

  it('matches trailing prompt glyph ❯', () => {
    expect(looksLikeQuestion('❯ ')).toBe(true)
  })

  it('matches trailing prompt glyph >', () => {
    expect(looksLikeQuestion('Enter value > ')).toBe(true)
  })

  it('matches "Press enter"', () => {
    expect(looksLikeQuestion('Press enter to continue')).toBe(true)
  })

  it('does NOT match plain progress output', () => {
    expect(looksLikeQuestion('Compiling... done')).toBe(false)
    expect(looksLikeQuestion('Writing 3 files')).toBe(false)
    expect(looksLikeQuestion('All tests passed')).toBe(false)
  })

  it('strips ANSI before matching', () => {
    // question mark hidden behind color codes
    expect(looksLikeQuestion('\x1B[33mShould I\x1B[0m continue?')).toBe(true)
  })
})

// ─── StatusDetector ───────────────────────────────────────────────────────────

describe('StatusDetector', () => {
  describe('fresh output → running', () => {
    it('returns running while output is recent', () => {
      const clock = makeClock(1000)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('Analyzing codebase...\n')
      clock.advance(100) // only 100ms since last output

      expect(d.status()).toBe('running')
    })

    it('returns running immediately after construction (no output yet)', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
      // no push, no advance — still within idle window
      expect(d.status()).toBe('running')
    })
  })

  describe('idle + question tail → needs', () => {
    it('returns needs when output goes idle and tail looks like a question', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('I found 3 issues.\nShould I fix them all? ')
      clock.advance(DEFAULT_IDLE + 1) // past the idle threshold

      expect(d.status()).toBe('needs')
    })

    it('returns needs for [y/n] prompt after idle', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('Remove unused imports? [y/n] ')
      clock.advance(5000)

      expect(d.status()).toBe('needs')
    })

    it('returns needs for trailing ❯ glyph after idle', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('Enter your choice:\n❯ ')
      clock.advance(5000)

      expect(d.status()).toBe('needs')
    })
  })

  describe('idle + plain tail → still running', () => {
    it('returns running when output is idle but tail is not a question', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('Installing dependencies...\nAdded 42 packages')
      clock.advance(DEFAULT_IDLE + 1)

      // No question pattern — stays running (agent may just be slow)
      expect(d.status()).toBe('running')
    })
  })

  describe('markExit', () => {
    it('returns done on exit code 0', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('All done.\n')
      d.markExit(0)

      expect(d.status()).toBe('done')
    })

    it('returns errored on non-zero exit code', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('fatal error\n')
      d.markExit(1)

      expect(d.status()).toBe('errored')
    })

    it('exit takes priority over idle inspection', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      d.push('Should I continue? ')
      clock.advance(DEFAULT_IDLE + 1)
      d.markExit(0) // exited cleanly despite pending question tail

      expect(d.status()).toBe('done')
    })
  })

  describe('ANSI in stream', () => {
    it('strips ANSI before idle inspection so patterns still fire', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      // Typical claude output: color codes wrapping the question
      d.push('\x1B[1mShould I\x1B[0m run the tests? ')
      clock.advance(DEFAULT_IDLE + 1)

      expect(d.status()).toBe('needs')
    })
  })

  describe('buffer bounding', () => {
    it('does not blow up with very large output', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      // Feed 100 KB of data — buffer stays bounded
      const chunk = 'x'.repeat(1000)
      for (let i = 0; i < 100; i++) d.push(chunk)

      clock.advance(DEFAULT_IDLE + 1)
      // Last 512 chars are all 'x', no question pattern
      expect(d.status()).toBe('running')
    })

    it('still detects question in tail after large output', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })

      const chunk = 'progress line\n'.repeat(500) // ~7 KB
      d.push(chunk)
      d.push('Should I proceed? ')
      clock.advance(DEFAULT_IDLE + 1)

      expect(d.status()).toBe('needs')
    })
  })

  describe('NEEDS_PATTERNS export', () => {
    it('is a non-empty array of RegExp', () => {
      expect(Array.isArray(NEEDS_PATTERNS)).toBe(true)
      expect(NEEDS_PATTERNS.length).toBeGreaterThan(0)
      NEEDS_PATTERNS.forEach((p) => expect(p).toBeInstanceOf(RegExp))
    })
  })
})

// ─── tailSignal / explicit markers ───────────────────────────────────────────

describe('tailSignal / explicit markers', () => {
  it('returns "needs" when tail ends with NEEDS_INPUT_MARKER', () => {
    expect(tailSignal(`Some output\n${NEEDS_INPUT_MARKER}`)).toBe('needs')
  })

  it('returns "needs" when tail ends with NEEDS_INPUT_MARKER followed by trailing newline', () => {
    expect(tailSignal(`Some output\n${NEEDS_INPUT_MARKER}\n`)).toBe('needs')
  })

  it('returns "needs" when tail ends with NEEDS_INPUT_MARKER followed by trailing whitespace', () => {
    expect(tailSignal(`Some output\n${NEEDS_INPUT_MARKER}   `)).toBe('needs')
  })

  it('returns "needs" when tail ends with NEEDS_INPUT_MARKER followed by a trailing ❯ glyph', () => {
    expect(tailSignal(`Some output\n${NEEDS_INPUT_MARKER}\n❯ `)).toBe('needs')
  })

  it('returns "done" when tail ends with DONE_MARKER', () => {
    expect(tailSignal(`All done.\n${DONE_MARKER}`)).toBe('done')
  })

  it('returns "done" when tail ends with DONE_MARKER followed by trailing whitespace', () => {
    expect(tailSignal(`All done.\n${DONE_MARKER}\n`)).toBe('done')
  })

  it('returns null when alphanumeric output follows the marker (marker not at tail)', () => {
    expect(tailSignal(`${NEEDS_INPUT_MARKER} more text here`)).toBeNull()
  })

  it('returns null when alphanumeric follows DONE_MARKER', () => {
    expect(tailSignal(`${DONE_MARKER} additional output`)).toBeNull()
  })

  it('returns null for plain output with no marker', () => {
    expect(tailSignal('Installing packages...\nAll done.')).toBeNull()
  })

  it('strips ANSI before matching (marker wrapped in color codes)', () => {
    const colored = `\x1B[32m${NEEDS_INPUT_MARKER}\x1B[0m`
    expect(tailSignal(colored)).toBe('needs')
  })

  it('StatusDetector.status() returns "needs" immediately after pushing a NEEDS_INPUT_MARKER tail WITHOUT advancing the clock', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    // Push the marker without advancing the clock — proves it is NOT idle-gated
    d.push(`Working on it...\n${NEEDS_INPUT_MARKER}`)
    // Do NOT advance the clock
    expect(d.status()).toBe('needs')
  })

  it('StatusDetector.status() returns "done" for a DONE_MARKER tail without exit', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(`PR opened successfully.\n${DONE_MARKER}`)
    // Do NOT advance the clock
    expect(d.status()).toBe('done')
  })

  it('after a needs marker, pushing further normal output returns "running" (within idle window)', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(`I need your input.\n${NEEDS_INPUT_MARKER}`)
    expect(d.status()).toBe('needs')
    // User replies and agent emits new output
    d.push('\nOk, continuing with the implementation...')
    clock.advance(100) // still within idle window
    expect(d.status()).toBe('running')
  })

  it('markExit still takes priority (exit code 0 → "done" even if NEEDS marker is in the tail)', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(`Waiting for input.\n${NEEDS_INPUT_MARKER}`)
    d.markExit(0)
    expect(d.status()).toBe('done')
  })

  it('returns "running" when tail ends with IN_PROGRESS_MARKER', () => {
    expect(tailSignal(`Working on the implementation...\n${IN_PROGRESS_MARKER}`)).toBe('running')
  })

  it('returns "running" when tail ends with IN_PROGRESS_MARKER followed by trailing whitespace/newline', () => {
    expect(tailSignal(`Working on the implementation...\n${IN_PROGRESS_MARKER}\n`)).toBe('running')
  })

  it('last marker wins: NEEDS_INPUT_MARKER earlier, IN_PROGRESS_MARKER at tail → "running"', () => {
    expect(tailSignal(`${NEEDS_INPUT_MARKER}\nOk, resuming work.\n${IN_PROGRESS_MARKER}`)).toBe(
      'running',
    )
  })

  it('last marker wins: IN_PROGRESS_MARKER earlier, DONE_MARKER at tail → "done"', () => {
    expect(tailSignal(`${IN_PROGRESS_MARKER}\nAll done, PR opened.\n${DONE_MARKER}`)).toBe('done')
  })

  it('StatusDetector.status() returns "running" immediately after pushing an IN_PROGRESS_MARKER tail WITHOUT advancing the clock', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(`Starting implementation...\n${IN_PROGRESS_MARKER}`)
    // Do NOT advance the clock
    expect(d.status()).toBe('running')
  })
})

// ─── applySignal / MCP channel ────────────────────────────────────────────────

describe('applySignal / MCP channel', () => {
  it('a "needs" signal survives ordinary non-marker output', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.applySignal('needs', 0)
    expect(d.status()).toBe('needs')
    // Agent keeps streaming a prose reply — none of it is an explicit marker.
    clock.advance(100)
    d.push('Sure, here is what I found in the codebase...')
    clock.advance(100)
    d.push(' and a few more sentences of explanation.')
    // The deliberate MCP signal is not reverted by ordinary output.
    expect(d.status()).toBe('needs')
  })

  it('a "needs" signal is superseded by a strictly-newer IN_PROGRESS_MARKER tail', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.applySignal('needs', 0)
    clock.advance(100)
    d.push('Still no marker here...')
    expect(d.status()).toBe('needs')
    // A strictly-newer explicit marker supersedes the stale signal.
    clock.advance(100)
    d.push(`Resuming work now.\n${IN_PROGRESS_MARKER}`)
    expect(d.status()).toBe('running')
  })

  it('a "running" signal survives its own non-marker output', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.applySignal('running', 0)
    clock.advance(100)
    d.push('Working on the change, editing files...')
    expect(d.status()).toBe('running')
    // A newer DONE_MARKER supersedes it.
    clock.advance(100)
    d.push(`All done.\n${DONE_MARKER}`)
    expect(d.status()).toBe('done')
  })

  it('a "done" signal is sticky even after later plain output is pushed', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.applySignal('done', 0)
    clock.advance(100)
    d.push('Some more output after done was reported')
    expect(d.status()).toBe('done')
  })

  it('a strictly-newer PTY marker wins over an older applySignal', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.applySignal('needs', 0)
    clock.advance(100)
    d.push(`Resuming and finishing up.\n${DONE_MARKER}`)
    expect(d.status()).toBe('done')
  })

  it('a signal strictly newer than the last output wins over a stale tail state', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push('Plain progress output, no markers.')
    clock.advance(100)
    d.applySignal('needs', clock.now())
    expect(d.status()).toBe('needs')
  })
})
