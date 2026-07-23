import { describe, it, expect } from 'vitest'
import {
  AXIS_LOCK_PX,
  OPEN_RATIO,
  FLICK_VELOCITY,
  swipeAxis,
  clampSwipeOffset,
  swipeSettle,
  swipeTargetOffset,
} from './swipe.js'

describe('swipeAxis', () => {
  it('returns null until movement exceeds the lock threshold on either axis', () => {
    expect(swipeAxis(0, 0)).toBe(null)
    expect(swipeAxis(AXIS_LOCK_PX - 1, 0)).toBe(null)
    expect(swipeAxis(0, AXIS_LOCK_PX - 1)).toBe(null)
  })

  it('locks horizontal when horizontal movement dominates', () => {
    expect(swipeAxis(20, 5)).toBe('horizontal')
    expect(swipeAxis(-20, 5)).toBe('horizontal')
  })

  it('locks vertical when vertical movement dominates (page scroll wins)', () => {
    expect(swipeAxis(5, 20)).toBe('vertical')
    expect(swipeAxis(5, -20)).toBe('vertical')
  })

  it('locks horizontal on an exact tie', () => {
    expect(swipeAxis(AXIS_LOCK_PX + 4, AXIS_LOCK_PX + 4)).toBe('horizontal')
  })
})

describe('clampSwipeOffset', () => {
  it('clamps to 0 on both sides when no action panels exist', () => {
    expect(clampSwipeOffset(50, 0, 0)).toBe(0)
    expect(clampSwipeOffset(-50, 0, 0)).toBe(0)
  })

  it('clamps a rightward drag to the left panel width', () => {
    expect(clampSwipeOffset(200, 80, 80)).toBe(80)
    expect(clampSwipeOffset(40, 80, 80)).toBe(40)
  })

  it('clamps a leftward drag to the right panel width', () => {
    expect(clampSwipeOffset(-200, 80, 72)).toBe(-72)
    expect(clampSwipeOffset(-40, 80, 72)).toBe(-40)
  })

  it('forbids dragging toward a side with no panel while allowing the other', () => {
    // No left panel: rightward drag (positive) stays 0, leftward allowed.
    expect(clampSwipeOffset(100, 0, 72)).toBe(0)
    expect(clampSwipeOffset(-100, 0, 72)).toBe(-72)
    // No right panel: leftward drag (negative) stays 0, rightward allowed.
    expect(clampSwipeOffset(100, 80, 0)).toBe(80)
    expect(clampSwipeOffset(-100, 80, 0)).toBe(0)
  })
})

describe('swipeSettle', () => {
  const LW = 80
  const RW = 72

  it('snaps closed when barely dragged', () => {
    expect(swipeSettle(10, LW, RW, 0)).toBe(null)
    expect(swipeSettle(-10, LW, RW, 0)).toBe(null)
  })

  it('opens left once past the open ratio of the left panel', () => {
    expect(swipeSettle(LW * OPEN_RATIO - 1, LW, RW, 0)).toBe(null)
    expect(swipeSettle(LW * OPEN_RATIO + 1, LW, RW, 0)).toBe('left')
    expect(swipeSettle(LW, LW, RW, 0)).toBe('left')
  })

  it('opens right once past the open ratio of the right panel', () => {
    expect(swipeSettle(-(RW * OPEN_RATIO - 1), LW, RW, 0)).toBe(null)
    expect(swipeSettle(-(RW * OPEN_RATIO + 1), LW, RW, 0)).toBe('right')
    expect(swipeSettle(-RW, LW, RW, 0)).toBe('right')
  })

  it('a flick toward an existing panel wins over a sub-threshold position', () => {
    expect(swipeSettle(5, LW, RW, FLICK_VELOCITY)).toBe('left')
    expect(swipeSettle(-5, LW, RW, -FLICK_VELOCITY)).toBe('right')
  })

  it('a flick toward a side with no panel does not open it', () => {
    expect(swipeSettle(5, 0, RW, FLICK_VELOCITY)).toBe(null)
    expect(swipeSettle(-5, LW, 0, -FLICK_VELOCITY)).toBe(null)
  })

  it('never opens a side that has no panel, regardless of distance', () => {
    expect(swipeSettle(200, 0, RW, 0)).toBe(null)
    expect(swipeSettle(-200, LW, 0, 0)).toBe(null)
  })

  it('a flick in the open direction beats closing even from an open position', () => {
    // Row is open-left (offset = LW); a continued rightward flick stays open.
    expect(swipeSettle(LW, LW, RW, FLICK_VELOCITY)).toBe('left')
  })
})

describe('swipeTargetOffset', () => {
  it('returns the left panel width for the left side', () => {
    expect(swipeTargetOffset('left', 80, 72)).toBe(80)
  })

  it('returns the negated right panel width for the right side', () => {
    expect(swipeTargetOffset('right', 80, 72)).toBe(-72)
  })

  it('returns 0 for closed', () => {
    expect(swipeTargetOffset(null, 80, 72)).toBe(0)
  })
})
