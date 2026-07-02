/**
 * Corpus tests — feed realistic claude-code TUI output (see
 * __fixtures__/tuiCorpus.ts) through StatusDetector and assert the expected
 * classification. Complements the synthetic-pattern tests in
 * statusDetector.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { StatusDetector } from './statusDetector.js'
import { DONE_MARKER } from '../shared/promptComposer.js'
import {
  permissionPrompt,
  thinkingSpinner,
  toolOutputStream,
  plainQuestion,
  doneWithMarker,
  needsWithMarker,
} from './__fixtures__/tuiCorpus.js'

const DEFAULT_IDLE = 4000

function makeClock(initial = 0) {
  let t = initial
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('StatusDetector / TUI corpus', () => {
  it('classifies a claude permission prompt as needs after idle', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(permissionPrompt)
    clock.advance(DEFAULT_IDLE + 1)
    expect(d.status()).toBe('needs')
  })

  it('does not false-positive a thinking spinner as needs', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(thinkingSpinner)
    clock.advance(DEFAULT_IDLE + 1)
    expect(d.status()).toBe('running')
  })

  it('classifies plain tool output stream as running after idle', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(toolOutputStream)
    clock.advance(DEFAULT_IDLE + 1)
    expect(d.status()).toBe('running')
  })

  it('classifies a plain free-text question as needs after idle', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(plainQuestion)
    clock.advance(DEFAULT_IDLE + 1)
    expect(d.status()).toBe('needs')
  })

  it('classifies a DONE_MARKER tail as done without idle/exit', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(doneWithMarker)
    expect(d.status()).toBe('done')
  })

  it('classifies a NEEDS_INPUT_MARKER tail as needs without idle', () => {
    const clock = makeClock(0)
    const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
    d.push(needsWithMarker)
    expect(d.status()).toBe('needs')
  })

  describe('MCP signal reconciliation', () => {
    it('applySignal("needs") with no new output returns needs immediately (no clock advance)', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
      d.push('Working on the implementation...')
      d.applySignal('needs')
      expect(d.status()).toBe('needs')
    })

    it('applySignal("done") is sticky even when later plain output is pushed', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
      d.applySignal('done')
      clock.advance(100)
      d.push('Still printing some trailing output...')
      expect(d.status()).toBe('done')
    })

    it('a strictly-newer PTY DONE marker overrides an earlier applySignal("needs")', () => {
      const clock = makeClock(0)
      const d = new StatusDetector({ idleMs: DEFAULT_IDLE, now: clock.now })
      d.applySignal('needs', 0)
      clock.advance(100)
      d.push(`All done.\n${DONE_MARKER}`)
      expect(d.status()).toBe('done')
    })
  })
})
