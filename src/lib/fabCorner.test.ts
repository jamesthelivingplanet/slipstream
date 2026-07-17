import { describe, it, expect } from 'vitest'
import {
  FAB_CORNER_KEY,
  DEFAULT_FAB_CORNER,
  FAB_SIZE_PX,
  FAB_CORNER_MARGIN_PX,
  FAB_HEADER_HEIGHT_PX,
  FAB_HEADER_CLEARANCE_PX,
  FAB_TIP_GAP_PX,
  FAB_DRAG_THRESHOLD_PX,
  nearestCorner,
  resolveCornerPosition,
  bubbleAnchorFor,
  pointerDirectionForCorner,
  isFabCorner,
} from './fabCorner.js'

const VW = 1200
const VH = 800

describe('fabCorner constants', () => {
  it('persistence key and default corner', () => {
    expect(FAB_CORNER_KEY).toBe('slipstream.fabCorner')
    expect(DEFAULT_FAB_CORNER).toBe('bl')
  })

  it('drag threshold is a small, non-zero px value', () => {
    expect(FAB_DRAG_THRESHOLD_PX).toBeGreaterThan(0)
    expect(FAB_DRAG_THRESHOLD_PX).toBeLessThan(20)
  })
})

describe('nearestCorner', () => {
  it('top-left quadrant', () => {
    expect(nearestCorner(10, 10, VW, VH)).toBe('tl')
  })

  it('top-right quadrant', () => {
    expect(nearestCorner(VW - 10, 10, VW, VH)).toBe('tr')
  })

  it('bottom-left quadrant', () => {
    expect(nearestCorner(10, VH - 10, VW, VH)).toBe('bl')
  })

  it('bottom-right quadrant', () => {
    expect(nearestCorner(VW - 10, VH - 10, VW, VH)).toBe('br')
  })

  it('resolves the exact center to bottom-right (ties go to b/r)', () => {
    expect(nearestCorner(VW / 2, VH / 2, VW, VH)).toBe('br')
  })

  it('a point just left of center-x, just above center-y is top-left', () => {
    expect(nearestCorner(VW / 2 - 1, VH / 2 - 1, VW, VH)).toBe('tl')
  })

  it('horizontal midpoint tie breaks right, vertical tie breaks bottom independently', () => {
    expect(nearestCorner(VW / 2, 10, VW, VH)).toBe('tr')
    expect(nearestCorner(10, VH / 2, VW, VH)).toBe('bl')
  })
})

describe('resolveCornerPosition', () => {
  it('bl: left margin, bottom margin', () => {
    expect(resolveCornerPosition('bl', VW, VH)).toEqual({
      left: FAB_CORNER_MARGIN_PX,
      top: VH - FAB_CORNER_MARGIN_PX - FAB_SIZE_PX,
    })
  })

  it('br: right margin, bottom margin', () => {
    expect(resolveCornerPosition('br', VW, VH)).toEqual({
      left: VW - FAB_CORNER_MARGIN_PX - FAB_SIZE_PX,
      top: VH - FAB_CORNER_MARGIN_PX - FAB_SIZE_PX,
    })
  })

  it('tl: left margin, below the header + clearance', () => {
    expect(resolveCornerPosition('tl', VW, VH)).toEqual({
      left: FAB_CORNER_MARGIN_PX,
      top: FAB_HEADER_HEIGHT_PX + FAB_HEADER_CLEARANCE_PX,
    })
  })

  it('tr: right margin, below the header + clearance', () => {
    expect(resolveCornerPosition('tr', VW, VH)).toEqual({
      left: VW - FAB_CORNER_MARGIN_PX - FAB_SIZE_PX,
      top: FAB_HEADER_HEIGHT_PX + FAB_HEADER_CLEARANCE_PX,
    })
  })

  it('top corners always clear the header regardless of viewport height', () => {
    const { top } = resolveCornerPosition('tl', VW, 400)
    expect(top).toBeGreaterThanOrEqual(FAB_HEADER_HEIGHT_PX)
  })

  it('never produces a left/top position that is only ever left/top (never right/bottom)', () => {
    for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
      const p = resolveCornerPosition(corner, VW, VH)
      expect(typeof p.left).toBe('number')
      expect(typeof p.top).toBe('number')
    }
  })
})

describe('bubbleAnchorFor', () => {
  it('bottom-left companion: bubble opens above (bottom-anchored), left-aligned', () => {
    const companion = resolveCornerPosition('bl', VW, VH)
    const anchor = bubbleAnchorFor('bl', companion, VW, VH)
    expect(anchor.bottom).toBe(VH - companion.top + FAB_TIP_GAP_PX)
    expect(anchor.left).toBe(companion.left)
    expect(anchor.top).toBeUndefined()
    expect(anchor.right).toBeUndefined()
  })

  it('bottom-right companion: bubble opens above, right-aligned', () => {
    const companion = resolveCornerPosition('br', VW, VH)
    const anchor = bubbleAnchorFor('br', companion, VW, VH)
    expect(anchor.bottom).toBe(VH - companion.top + FAB_TIP_GAP_PX)
    expect(anchor.right).toBe(VW - companion.left - FAB_SIZE_PX)
    expect(anchor.top).toBeUndefined()
    expect(anchor.left).toBeUndefined()
  })

  it('top-left companion: bubble opens below (top-anchored), left-aligned', () => {
    const companion = resolveCornerPosition('tl', VW, VH)
    const anchor = bubbleAnchorFor('tl', companion, VW, VH)
    expect(anchor.top).toBe(companion.top + FAB_SIZE_PX + FAB_TIP_GAP_PX)
    expect(anchor.left).toBe(companion.left)
    expect(anchor.bottom).toBeUndefined()
    expect(anchor.right).toBeUndefined()
  })

  it('top-right companion: bubble opens below, right-aligned', () => {
    const companion = resolveCornerPosition('tr', VW, VH)
    const anchor = bubbleAnchorFor('tr', companion, VW, VH)
    expect(anchor.top).toBe(companion.top + FAB_SIZE_PX + FAB_TIP_GAP_PX)
    expect(anchor.right).toBe(VW - companion.left - FAB_SIZE_PX)
    expect(anchor.bottom).toBeUndefined()
    expect(anchor.left).toBeUndefined()
  })

  it('the bubble never touches the companion — always separated by at least the gap', () => {
    for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
      const companion = resolveCornerPosition(corner, VW, VH)
      const anchor = bubbleAnchorFor(corner, companion, VW, VH)
      if (anchor.bottom !== undefined) {
        expect(anchor.bottom).toBeGreaterThanOrEqual(VH - companion.top + FAB_TIP_GAP_PX)
      }
      if (anchor.top !== undefined) {
        expect(anchor.top).toBeGreaterThanOrEqual(companion.top + FAB_SIZE_PX + FAB_TIP_GAP_PX)
      }
    }
  })
})

describe('pointerDirectionForCorner', () => {
  it('bottom corners point the tail down', () => {
    expect(pointerDirectionForCorner('bl').vertical).toBe('down')
    expect(pointerDirectionForCorner('br').vertical).toBe('down')
  })

  it('top corners point the tail up', () => {
    expect(pointerDirectionForCorner('tl').vertical).toBe('up')
    expect(pointerDirectionForCorner('tr').vertical).toBe('up')
  })

  it('left corners align the tail left, right corners align it right', () => {
    expect(pointerDirectionForCorner('tl').horizontal).toBe('left')
    expect(pointerDirectionForCorner('bl').horizontal).toBe('left')
    expect(pointerDirectionForCorner('tr').horizontal).toBe('right')
    expect(pointerDirectionForCorner('br').horizontal).toBe('right')
  })
})

describe('isFabCorner', () => {
  it('accepts all four valid corners', () => {
    expect(isFabCorner('tl')).toBe(true)
    expect(isFabCorner('tr')).toBe(true)
    expect(isFabCorner('bl')).toBe(true)
    expect(isFabCorner('br')).toBe(true)
  })

  it('rejects null, undefined, and garbage strings', () => {
    expect(isFabCorner(null)).toBe(false)
    expect(isFabCorner(undefined)).toBe(false)
    expect(isFabCorner('')).toBe(false)
    expect(isFabCorner('top-left')).toBe(false)
    expect(isFabCorner('BL')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isFabCorner(1)).toBe(false)
    expect(isFabCorner({})).toBe(false)
  })
})
