import { describe, it, expect } from 'vitest'
import { MASCOT_NAME, NOTIFICATION_TITLES, NOTIFICATION_TITLE_MAX_LENGTH, pick } from './mascot.js'
import type { NotificationKind } from './mascot.js'

describe('MASCOT_NAME', () => {
  it('is Nulliel', () => {
    expect(MASCOT_NAME).toBe('Nulliel')
  })
})

const KINDS: NotificationKind[] = ['needsInput', 'needsBlocked', 'needsApproval', 'done', 'running']

describe('NOTIFICATION_TITLES', () => {
  it('has a non-empty pool for every kind', () => {
    for (const kind of KINDS) {
      expect(NOTIFICATION_TITLES[kind].length).toBeGreaterThan(0)
    }
  })

  it('every title is at or under the length cap', () => {
    for (const kind of KINDS) {
      for (const title of NOTIFICATION_TITLES[kind]) {
        expect(title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX_LENGTH)
      }
    }
  })

  it('every title is non-empty, trimmed plain text', () => {
    for (const kind of KINDS) {
      for (const title of NOTIFICATION_TITLES[kind]) {
        expect(title.length).toBeGreaterThan(0)
        expect(title).toBe(title.trim())
      }
    }
  })

  it('has no duplicate titles within a pool', () => {
    for (const kind of KINDS) {
      const unique = new Set(NOTIFICATION_TITLES[kind])
      expect(unique.size).toBe(NOTIFICATION_TITLES[kind].length)
    }
  })

  it('every title mentions the mascot or leads with an emoji', () => {
    const emojiLead = /^\p{Extended_Pictographic}/u
    for (const kind of KINDS) {
      for (const title of NOTIFICATION_TITLES[kind]) {
        expect(title.includes(MASCOT_NAME) || emojiLead.test(title)).toBe(true)
      }
    }
  })
})

describe('pick', () => {
  it('is deterministic: same seed always yields the same line', () => {
    const pool = NOTIFICATION_TITLES.needsInput
    const a = pick(pool, 'session-1:needsInput')
    const b = pick(pool, 'session-1:needsInput')
    expect(a).toBe(b)
  })

  it('picks a line that actually belongs to the pool', () => {
    const pool = NOTIFICATION_TITLES.done
    const picked = pick(pool, 'session-42:done')
    expect(pool).toContain(picked)
  })

  it('spreads different seeds across a multi-entry pool', () => {
    const pool = NOTIFICATION_TITLES.done
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      seen.add(pick(pool, `session-${i}:done`))
    }
    // With 50 varied seeds against a small pool, expect more than one variant
    // to show up — guards against a picker that's secretly constant.
    expect(seen.size).toBeGreaterThan(1)
  })

  it('returns empty string for an empty pool rather than throwing', () => {
    expect(pick([], 'anything')).toBe('')
  })
})
