import { describe, it, expect } from 'vitest'
import {
  MASCOT_NAME,
  ONBOARDING_SCREENS,
  ONBOARDING_MODAL_BULLETS,
  ONBOARDING_LINE_MAX_LENGTH,
  ONBOARDING_BODY_MAX_LENGTH,
  ONBOARDING_BULLET_MAX_LENGTH,
} from './onboardingContent.js'

describe('MASCOT_NAME', () => {
  it('is Nulliel', () => {
    expect(MASCOT_NAME).toBe('Nulliel')
  })
})

describe('ONBOARDING_SCREENS', () => {
  it('has exactly 5 screens', () => {
    expect(ONBOARDING_SCREENS.length).toBe(5)
  })

  it('has unique, non-empty ids', () => {
    const ids = ONBOARDING_SCREENS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })

  it('every title and line is non-empty, trimmed plain text', () => {
    for (const s of ONBOARDING_SCREENS) {
      expect(s.title).toBe(s.title.trim())
      expect(s.title.length).toBeGreaterThan(0)
      expect(s.line).toBe(s.line.trim())
      expect(s.line.length).toBeGreaterThan(0)
    }
  })

  it('every line is at or under the line length cap', () => {
    for (const s of ONBOARDING_SCREENS) {
      expect(s.line.length).toBeLessThanOrEqual(ONBOARDING_LINE_MAX_LENGTH)
    }
  })

  it('ONBOARDING_LINE_MAX_LENGTH is 140', () => {
    expect(ONBOARDING_LINE_MAX_LENGTH).toBe(140)
  })

  it('ONBOARDING_BODY_MAX_LENGTH is 180', () => {
    expect(ONBOARDING_BODY_MAX_LENGTH).toBe(180)
  })

  it('every bullet is non-empty and at or under the bullet length cap', () => {
    for (const s of ONBOARDING_SCREENS) {
      for (const b of s.bullets ?? []) {
        expect(b).toBe(b.trim())
        expect(b.length).toBeGreaterThan(0)
        expect(b.length).toBeLessThanOrEqual(ONBOARDING_BULLET_MAX_LENGTH)
      }
    }
  })

  it('ONBOARDING_BULLET_MAX_LENGTH is 100', () => {
    expect(ONBOARDING_BULLET_MAX_LENGTH).toBe(100)
  })

  it('the first screen reveals MASCOT_NAME', () => {
    expect(ONBOARDING_SCREENS[0].id).toBe('meet-nulliel')
    expect(ONBOARDING_SCREENS[0].line).toContain(MASCOT_NAME)
  })

  it('the notifications screen names MASCOT_NAME as the one who alerts you', () => {
    const notif = ONBOARDING_SCREENS.find((s) => s.id === 'notifications')
    expect(notif).toBeDefined()
    expect(notif?.line).toContain(MASCOT_NAME)
  })

  it('the mobile-features screen covers the FAB, drawer, Diff, and Hand off', () => {
    const mobileScreen = ONBOARDING_SCREENS.find((s) => s.id === 'on-your-phone')
    expect(mobileScreen?.bullets?.length).toBe(4)
    const joined = (mobileScreen?.bullets ?? []).join(' ').toLowerCase()
    expect(joined).toContain('drawer')
    expect(joined).toContain('diff')
    expect(joined).toContain('hand off')
  })

  it('the final screen signs off and does not introduce a new claim', () => {
    const last = ONBOARDING_SCREENS[ONBOARDING_SCREENS.length - 1]
    expect(last.id).toBe('ready')
    expect(last.bullets).toBeUndefined()
  })
})

describe('ONBOARDING_MODAL_BULLETS', () => {
  it('has between 3 and 4 bullets', () => {
    expect(ONBOARDING_MODAL_BULLETS.length).toBeGreaterThanOrEqual(3)
    expect(ONBOARDING_MODAL_BULLETS.length).toBeLessThanOrEqual(4)
  })

  it('every bullet is non-empty and reused verbatim from ONBOARDING_SCREENS', () => {
    const allScreenStrings = new Set(
      ONBOARDING_SCREENS.flatMap((s) => [s.line, ...(s.bullets ?? [])]),
    )
    for (const b of ONBOARDING_MODAL_BULLETS) {
      expect(b.length).toBeGreaterThan(0)
      expect(allScreenStrings.has(b)).toBe(true)
    }
  })

  it('has no duplicate bullets', () => {
    expect(new Set(ONBOARDING_MODAL_BULLETS).size).toBe(ONBOARDING_MODAL_BULLETS.length)
  })
})
