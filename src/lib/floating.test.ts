import { describe, it, expect } from 'vitest'
import { placeAnchor, ANCHOR_GAP } from './floating.js'

describe('placeAnchor', () => {
  const VP = { height: 800, width: 800 }

  it('opens directly below the trigger when there is room', () => {
    const trigger = { left: 100, top: 200, bottom: 240, width: 300 }
    const { left, minWidth, top } = placeAnchor(trigger, { height: 120, width: 300 }, VP)
    expect(left).toBe(100)
    expect(minWidth).toBe(300)
    expect(top).toBe(240 + ANCHOR_GAP)
  })

  it('keeps the menu aligned to the trigger left/width', () => {
    const trigger = { left: 40, top: 100, bottom: 138, width: 220 }
    const { left, minWidth } = placeAnchor(trigger, { height: 100, width: 220 }, VP)
    expect(left).toBe(40)
    expect(minWidth).toBe(220)
  })

  it('prefers below on a tie (equal space above and below)', () => {
    const trigger = { left: 0, top: 400, bottom: 440, width: 50 }
    const { top } = placeAnchor(trigger, { height: 120, width: 50 }, VP)
    expect(top).toBe(440 + ANCHOR_GAP)
  })

  it('flips above when below has less room than above', () => {
    // 60px below, 700px above, menu 120px → flip up
    const trigger = { left: 0, top: 700, bottom: 740, width: 80 }
    const { top } = placeAnchor(trigger, { height: 120, width: 80 }, VP)
    expect(top).toBe(700 - ANCHOR_GAP - 120)
  })

  it('clamps the flipped top to the gap so it never leaves the viewport', () => {
    // Tiny viewport: spaceBelow=10 (< menuHeight), spaceAbove=30 → flip up, but
    // top would go negative, so it clamps to gap.
    const trigger = { left: 0, top: 30, bottom: 40, width: 60 }
    const { top } = placeAnchor(trigger, { height: 120, width: 60 }, { height: 50, width: 800 })
    expect(top).toBe(ANCHOR_GAP)
  })

  it('respects a custom gap', () => {
    const trigger = { left: 0, top: 200, bottom: 240, width: 100 }
    const { top } = placeAnchor(trigger, { height: 100, width: 100 }, VP, 12)
    expect(top).toBe(240 + 12)
  })

  it('clamps left when the menu would overflow the right viewport edge', () => {
    // Trigger near the right edge of a narrow (mobile) viewport; menu is
    // much wider than the trigger, so left must be pulled back to fit.
    const trigger = { left: 360, top: 100, bottom: 140, width: 40 }
    const { left } = placeAnchor(trigger, { height: 80, width: 160 }, { height: 800, width: 390 })
    expect(left).toBe(390 - 160 - ANCHOR_GAP)
  })

  it('never lets left go below the gap, even in a narrow viewport with a wide menu', () => {
    const trigger = { left: 0, top: 100, bottom: 140, width: 40 }
    const { left } = placeAnchor(trigger, { height: 80, width: 350 }, { height: 800, width: 390 })
    expect(left).toBe(ANCHOR_GAP)
  })
})
