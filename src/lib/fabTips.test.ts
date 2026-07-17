import { describe, it, expect } from 'vitest'
import {
  FAB_TIP_FIRST_DELAY_MS,
  FAB_TIP_MIN_GAP_MS,
  FAB_TIP_MAX_GAP_MS,
  FAB_TIP_VISIBLE_MS,
  FAB_TIP_INDEX_KEY,
  FAB_TIPS_ENABLED_KEY,
  FAB_ANGEL_ENABLED_KEY,
  firstTipDueAtMs,
  isTipDue,
  tipAutoHideAtMs,
  nextTipDueAtMs,
  nextTipIndex,
  clampTipIndex,
} from './fabTips.js'

describe('fabTips constants', () => {
  it('first tip is due no sooner than ~60s after boot', () => {
    expect(FAB_TIP_FIRST_DELAY_MS).toBe(60_000)
  })

  it('subsequent tips are gapped 6-8 minutes apart', () => {
    expect(FAB_TIP_MIN_GAP_MS).toBe(6 * 60_000)
    expect(FAB_TIP_MAX_GAP_MS).toBe(8 * 60_000)
    expect(FAB_TIP_MIN_GAP_MS).toBeLessThan(FAB_TIP_MAX_GAP_MS)
  })

  it('a shown tip auto-hides after ~12s', () => {
    expect(FAB_TIP_VISIBLE_MS).toBe(12_000)
  })

  it('persistence keys are namespaced under slipstream.*', () => {
    expect(FAB_TIP_INDEX_KEY).toBe('slipstream.fabTipIndex')
    expect(FAB_TIPS_ENABLED_KEY).toBe('slipstream.fabTips')
    expect(FAB_ANGEL_ENABLED_KEY).toBe('slipstream.fabAngel')
  })
})

describe('firstTipDueAtMs', () => {
  it('is exactly FAB_TIP_FIRST_DELAY_MS after boot', () => {
    expect(firstTipDueAtMs(1_000_000)).toBe(1_000_000 + FAB_TIP_FIRST_DELAY_MS)
  })
})

describe('isTipDue', () => {
  it('is false before the due time', () => {
    expect(isTipDue(59_999, 60_000)).toBe(false)
  })

  it('is true right at the due time', () => {
    expect(isTipDue(60_000, 60_000)).toBe(true)
  })

  it('is true well past the due time', () => {
    expect(isTipDue(999_999, 60_000)).toBe(true)
  })
})

describe('tipAutoHideAtMs', () => {
  it('is exactly FAB_TIP_VISIBLE_MS after the tip was shown', () => {
    expect(tipAutoHideAtMs(5_000)).toBe(5_000 + FAB_TIP_VISIBLE_MS)
  })
})

describe('nextTipDueAtMs', () => {
  it('adds exactly the min gap when rand() returns 0', () => {
    expect(nextTipDueAtMs(0, () => 0)).toBe(FAB_TIP_MIN_GAP_MS)
  })

  it('adds exactly the max gap when rand() returns just under 1', () => {
    const result = nextTipDueAtMs(0, () => 1)
    expect(result).toBe(FAB_TIP_MAX_GAP_MS)
  })

  it('stays within [min, max] for any rand() in [0, 1)', () => {
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.99]) {
      const delta = nextTipDueAtMs(0, () => r)
      expect(delta).toBeGreaterThanOrEqual(FAB_TIP_MIN_GAP_MS)
      expect(delta).toBeLessThanOrEqual(FAB_TIP_MAX_GAP_MS)
    }
  })

  it('is relative to the given nowMs', () => {
    expect(nextTipDueAtMs(1_000_000, () => 0)).toBe(1_000_000 + FAB_TIP_MIN_GAP_MS)
  })

  it('defaults to Math.random when rand is omitted', () => {
    const before = Date.now()
    const due = nextTipDueAtMs(before)
    expect(due).toBeGreaterThanOrEqual(before + FAB_TIP_MIN_GAP_MS)
    expect(due).toBeLessThanOrEqual(before + FAB_TIP_MAX_GAP_MS)
  })
})

describe('nextTipIndex', () => {
  it('advances by one', () => {
    expect(nextTipIndex(0, 5)).toBe(1)
    expect(nextTipIndex(3, 5)).toBe(4)
  })

  it('wraps past the end back to 0', () => {
    expect(nextTipIndex(4, 5)).toBe(0)
  })

  it('returns 0 for an empty or invalid tip list', () => {
    expect(nextTipIndex(0, 0)).toBe(0)
    expect(nextTipIndex(2, 0)).toBe(0)
  })
})

describe('clampTipIndex', () => {
  it('passes a valid in-range index through unchanged', () => {
    expect(clampTipIndex(3, 12)).toBe(3)
  })

  it('wraps an index that is too large (list shrank since it was persisted)', () => {
    expect(clampTipIndex(15, 12)).toBe(3)
  })

  it('floors a fractional index', () => {
    expect(clampTipIndex(3.9, 12)).toBe(3)
  })

  it('falls back to 0 for negative, NaN, or non-finite values', () => {
    expect(clampTipIndex(-1, 12)).toBe(0)
    expect(clampTipIndex(NaN, 12)).toBe(0)
    expect(clampTipIndex(Infinity, 12)).toBe(0)
  })

  it('returns 0 when the tip list is empty', () => {
    expect(clampTipIndex(5, 0)).toBe(0)
  })
})
