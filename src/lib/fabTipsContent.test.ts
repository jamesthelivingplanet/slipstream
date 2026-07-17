import { describe, it, expect } from 'vitest'
import { FAB_TIPS, FAB_TIP_MAX_LENGTH } from './fabTipsContent.js'

describe('FAB_TIPS', () => {
  it('has between 10 and 14 tips', () => {
    expect(FAB_TIPS.length).toBeGreaterThanOrEqual(10)
    expect(FAB_TIPS.length).toBeLessThanOrEqual(14)
  })

  it('every tip is at or under the character cap', () => {
    for (const tip of FAB_TIPS) {
      expect(tip.length).toBeLessThanOrEqual(FAB_TIP_MAX_LENGTH)
    }
  })

  it('FAB_TIP_MAX_LENGTH is 120', () => {
    expect(FAB_TIP_MAX_LENGTH).toBe(120)
  })

  it('every tip is non-empty, trimmed plain text', () => {
    for (const tip of FAB_TIPS) {
      expect(tip.length).toBeGreaterThan(0)
      expect(tip).toBe(tip.trim())
    }
  })

  it('has no duplicate tips', () => {
    const unique = new Set(FAB_TIPS)
    expect(unique.size).toBe(FAB_TIPS.length)
  })

  it('does not bake the oracle-voice label into the tip body', () => {
    // "the angel observes" is rendered by NewAgentFab.svelte as a separate
    // label — the tip body itself must stay plain and practical.
    for (const tip of FAB_TIPS) {
      expect(tip.toLowerCase()).not.toContain('the angel')
      expect(tip.toLowerCase()).not.toContain('observes')
    }
  })
})
