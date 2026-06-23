import { describe, it, expect } from 'vitest'
import { isMobileWidth, MOBILE_MEDIA_QUERY, MOBILE_BREAKPOINT } from './responsive.js'

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
