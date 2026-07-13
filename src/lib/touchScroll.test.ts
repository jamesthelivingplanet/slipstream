import { describe, it, expect } from 'vitest'
import { TouchScrollTracker, momentumStep } from './touchScroll.js'

const CELL = 16 // px per row used across these tests

function tracker(cellHeight = CELL): TouchScrollTracker {
  return new TouchScrollTracker(() => cellHeight)
}

describe('TouchScrollTracker', () => {
  it('finger moving up (y decreasing) scrolls toward the bottom (positive lines)', () => {
    const t = tracker()
    t.start(200, 0)
    const lines = t.move(200 - CELL * 3, 50) // moved up 3 cells worth of px
    expect(lines).toBe(3)
  })

  it('finger moving down (y increasing) scrolls toward the top (negative lines)', () => {
    const t = tracker()
    t.start(100, 0)
    const lines = t.move(100 + CELL * 2, 50) // moved down 2 cells worth of px
    expect(lines).toBe(-2)
  })

  it('carries the fractional remainder across small moves', () => {
    // 3 moves of 6px at a 16px cell height: 6/16 = 0.375 each, summing to
    // 1.125 — only the third move should cross a whole line.
    const t = tracker()
    t.start(1000, 0)
    const l1 = t.move(994, 10) // -6px
    const l2 = t.move(988, 20) // -6px
    const l3 = t.move(982, 30) // -6px
    expect(l1).toBe(0)
    expect(l2).toBe(0)
    expect(l3).toBe(1)
    expect(l1 + l2 + l3).toBe(1)
  })

  it('start() resets the fractional remainder', () => {
    const t = tracker()
    t.start(1000, 0)
    // Builds a 0.875-line remainder (14px / 16px), just under a full line.
    expect(t.move(1000 - 14, 10)).toBe(0)

    t.start(500, 100) // reset — remainder must not carry into the new gesture
    // An identical 14px move should again land just under a full line. If the
    // old 0.875 remainder had leaked through, 0.875 + 0.875 = 1.75 would
    // report 1 line here instead of 0.
    const lines = t.move(500 - 14, 110)
    expect(lines).toBe(0)
  })

  it('falls back to a default cell height when given a non-positive value', () => {
    const t = tracker(0)
    t.start(200, 0)
    // With the 16px fallback, a 16px move should be exactly one line.
    expect(t.move(184, 10)).toBe(1)
  })

  describe('end() release velocity', () => {
    it('returns ~0 after a pause (only recent samples count)', () => {
      const t = tracker()
      t.start(1000, 0)
      t.move(900, 10) // a fast early move
      // Long pause before release — over 100ms since the last sample.
      const v = t.end(500)
      expect(v).toBe(0)
    })

    it('returns non-zero, correctly-signed velocity for a flick', () => {
      const t = tracker()
      t.start(500, 0)
      t.move(400, 20)
      t.move(300, 40) // finger moving up throughout
      const v = t.end(50)
      expect(v).toBeGreaterThan(0)
    })

    it('velocity direction matches the pan direction for a downward flick', () => {
      const t = tracker()
      t.start(100, 0)
      t.move(200, 20)
      t.move(300, 40) // finger moving down throughout
      const v = t.end(50)
      expect(v).toBeLessThan(0)
    })

    it('single-sample gestures (no move) report 0 velocity', () => {
      const t = tracker()
      t.start(100, 0)
      expect(t.end(10)).toBe(0)
    })
  })
})

describe('momentumStep', () => {
  it('decays velocity toward zero and eventually stops', () => {
    let velocity = 0.05 // a brisk flick, lines/ms
    let remainder = 0
    let steps = 0
    while (velocity !== 0 && steps < 1000) {
      const result = momentumStep(velocity, 16, remainder)
      velocity = result.velocity
      remainder = result.remainder
      steps++
    }
    expect(velocity).toBe(0)
    expect(steps).toBeGreaterThan(1) // didn't stop instantly
    expect(steps).toBeLessThan(1000) // did actually terminate
  })

  it('carries fractional lines across frames', () => {
    // A small velocity that produces sub-line distances per frame should
    // still accumulate to whole lines over several frames.
    const velocity = 0.01 // lines/ms
    let remainder = 0
    let totalLines = 0
    let v = velocity
    for (let i = 0; i < 50 && v !== 0; i++) {
      const result = momentumStep(v, 16, remainder)
      v = result.velocity
      remainder = result.remainder
      totalLines += result.lines
    }
    expect(totalLines).toBeGreaterThan(0)
  })

  it('reports 0 lines and 0 velocity for a dt of 0', () => {
    const result = momentumStep(0.05, 0, 0.2)
    expect(result.lines).toBe(0)
    expect(result.velocity).toBe(0)
  })

  it('reports stopped (0 velocity, 0 lines) for a below-epsilon velocity', () => {
    const result = momentumStep(0.00001, 16, 0)
    expect(result.velocity).toBe(0)
    expect(result.lines).toBe(0)
  })

  it('preserves the sign of velocity while decaying', () => {
    const result = momentumStep(-0.05, 16, 0)
    expect(result.velocity).toBeLessThan(0)
  })
})
