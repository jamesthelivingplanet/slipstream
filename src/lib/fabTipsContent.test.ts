import { describe, it, expect } from 'vitest'
import {
  FAB_TIPS,
  FAB_TIP_MAX_LENGTH,
  FAB_TIP_INTROS,
  FAB_TIP_INTRO_MAX_LENGTH,
} from './fabTipsContent.js'
import { MASCOT_NAME } from '../../electron/shared/mascot.js'

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

describe('FAB_TIP_INTROS', () => {
  it('is non-empty', () => {
    expect(FAB_TIP_INTROS.length).toBeGreaterThan(0)
  })

  it('every intro is at or under the character cap', () => {
    for (const intro of FAB_TIP_INTROS) {
      expect(intro.length).toBeLessThanOrEqual(FAB_TIP_INTRO_MAX_LENGTH)
    }
  })

  it('FAB_TIP_INTRO_MAX_LENGTH is 40', () => {
    expect(FAB_TIP_INTRO_MAX_LENGTH).toBe(40)
  })

  it('every intro is non-empty, trimmed plain text', () => {
    for (const intro of FAB_TIP_INTROS) {
      expect(intro.length).toBeGreaterThan(0)
      expect(intro).toBe(intro.trim())
    }
  })

  it('has no duplicate intros', () => {
    const unique = new Set(FAB_TIP_INTROS)
    expect(unique.size).toBe(FAB_TIP_INTROS.length)
  })

  it('none say "the angel" — the old static label is fully replaced', () => {
    for (const intro of FAB_TIP_INTROS) {
      expect(intro.toLowerCase()).not.toContain('the angel')
    }
  })

  it('at least one intro mentions the mascot by name', () => {
    expect(FAB_TIP_INTROS.some((intro) => intro.includes(MASCOT_NAME))).toBe(true)
  })
})
