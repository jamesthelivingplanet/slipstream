import { describe, it, expect } from 'vitest'
import { placeAnchor, ANCHOR_GAP } from './floating.js'

describe('placeAnchor', () => {
  const VP = 800

  it('opens directly below the trigger when there is room', () => {
    const trigger = { left: 100, top: 200, bottom: 240, width: 300 }
    const { left, top, width } = placeAnchor(trigger, 120, VP)
    expect(left).toBe(100)
    expect(width).toBe(300)
    expect(top).toBe(240 + ANCHOR_GAP)
  })

  it('keeps the menu aligned to the trigger left/width', () => {
    const trigger = { left: 40, top: 100, bottom: 138, width: 220 }
    const { left, width } = placeAnchor(trigger, 100, VP)
    expect(left).toBe(40)
    expect(width).toBe(220)
  })

  it('prefers below on a tie (equal space above and below)', () => {
    const trigger = { left: 0, top: 400, bottom: 440, width: 50 }
    const { top } = placeAnchor(trigger, 120, VP)
    expect(top).toBe(440 + ANCHOR_GAP)
  })

  it('flips above when below has less room than above', () => {
    // 60px below, 700px above, menu 120px → flip up
    const trigger = { left: 0, top: 700, bottom: 740, width: 80 }
    const { top } = placeAnchor(trigger, 120, VP)
    expect(top).toBe(700 - ANCHOR_GAP - 120)
  })

  it('clamps the flipped top to the gap so it never leaves the viewport', () => {
    // Tiny viewport: spaceBelow=10 (< menuHeight), spaceAbove=30 → flip up, but
    // top would go negative, so it clamps to gap.
    const trigger = { left: 0, top: 30, bottom: 40, width: 60 }
    const { top } = placeAnchor(trigger, 120, 50)
    expect(top).toBe(ANCHOR_GAP)
  })

  it('respects a custom gap', () => {
    const trigger = { left: 0, top: 200, bottom: 240, width: 100 }
    const { top } = placeAnchor(trigger, 100, VP, 12)
    expect(top).toBe(240 + 12)
  })
})
