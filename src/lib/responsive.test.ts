import { describe, it, expect } from 'vitest'
import {
  isMobileWidth,
  MOBILE_MEDIA_QUERY,
  MOBILE_BREAKPOINT,
  DRAWER_DISMISS_PX,
  shouldDismissDrawer,
  keyboardInset,
  KEYBOARD_MIN_INSET,
} from './responsive.js'

describe('responsive', () => {
  describe('isMobileWidth', () => {
    it('returns true for 699 (below breakpoint)', () => {
      expect(isMobileWidth(699)).toBe(true)
    })

    it('returns true for 700 (at breakpoint, inclusive)', () => {
      expect(isMobileWidth(700)).toBe(true)
    })

    it('returns false for 701 (above breakpoint)', () => {
      expect(isMobileWidth(701)).toBe(false)
    })

    it('returns true for 0 (extreme low)', () => {
      expect(isMobileWidth(0)).toBe(true)
    })

    it('returns true for 320 (phone width)', () => {
      expect(isMobileWidth(320)).toBe(true)
    })

    it('returns false for 1024 (tablet/desktop)', () => {
      expect(isMobileWidth(1024)).toBe(false)
    })

    it('returns false for 1920 (desktop)', () => {
      expect(isMobileWidth(1920)).toBe(false)
    })
  })

  it('MOBILE_MEDIA_QUERY equals "(max-width: 700px)"', () => {
    expect(MOBILE_MEDIA_QUERY).toBe('(max-width: 700px)')
  })

  it('MOBILE_BREAKPOINT equals 700', () => {
    expect(MOBILE_BREAKPOINT).toBe(700)
  })
})

describe('drawer dismiss', () => {
  it('DRAWER_DISMISS_PX equals 72', () => {
    expect(DRAWER_DISMISS_PX).toBe(72)
  })

  it('does not dismiss a drag below the threshold', () => {
    expect(shouldDismissDrawer(0)).toBe(false)
    expect(shouldDismissDrawer(71)).toBe(false)
  })

  it('dismisses at or above the threshold', () => {
    expect(shouldDismissDrawer(72)).toBe(true)
    expect(shouldDismissDrawer(400)).toBe(true)
  })

  it('does not dismiss upward (negative) drags', () => {
    expect(shouldDismissDrawer(-10)).toBe(false)
    expect(shouldDismissDrawer(-400)).toBe(false)
  })
})

describe('keyboardInset', () => {
  it('returns 0 when the visual viewport matches the window', () => {
    expect(keyboardInset(800, 800, 0)).toBe(0)
  })

  it('returns 0 for a shortfall below the threshold (URL-bar chrome)', () => {
    expect(keyboardInset(800, 740, 0)).toBe(0)
  })

  it('returns 0 right at one below the threshold', () => {
    expect(keyboardInset(800, 800 - (KEYBOARD_MIN_INSET - 1), 0)).toBe(0)
  })

  it('returns the inset for a keyboard-sized shortfall', () => {
    expect(keyboardInset(800, 450, 0)).toBe(350)
  })

  it('returns the inset right at the threshold', () => {
    expect(keyboardInset(800, 800 - KEYBOARD_MIN_INSET, 0)).toBe(KEYBOARD_MIN_INSET)
  })

  it('accounts for offsetTop (iOS scrolls the visual viewport)', () => {
    expect(keyboardInset(800, 450, 350)).toBe(0)
  })

  it('is never negative', () => {
    expect(keyboardInset(800, 900, 0)).toBe(0)
    expect(keyboardInset(800, 800, 100)).toBe(0)
  })

  it('reports 0 while pinch-zoomed', () => {
    expect(keyboardInset(800, 400, 0, 2)).toBe(0)
  })

  it('still reports an inset at explicit scale 1', () => {
    expect(keyboardInset(800, 450, 0, 1)).toBe(350)
  })
})
