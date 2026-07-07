import { describe, it, expect } from 'vitest'
import { dayKeyFromMs, formatTokens, formatCost } from './usageFormat.js'

describe('dayKeyFromMs', () => {
  it('produces a UTC YYYY-MM-DD string', () => {
    // 2026-07-01T13:14:15Z → '2026-07-01'
    expect(dayKeyFromMs(Date.UTC(2026, 6, 1, 13, 14, 15))).toBe('2026-07-01')
  })

  it('respects UTC day boundaries (not local)', () => {
    // A timestamp late on 2026-07-01 UTC; must be 07-01 regardless of local TZ.
    expect(dayKeyFromMs(Date.UTC(2026, 6, 1, 23, 59, 0))).toBe('2026-07-01')
    expect(dayKeyFromMs(Date.UTC(2026, 6, 2, 0, 0, 0))).toBe('2026-07-02')
  })
})

describe('formatTokens', () => {
  it('renders sub-thousand counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('renders thousands with a k suffix', () => {
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(9500)).toBe('9.5k')
    expect(formatTokens(50000)).toBe('50k')
  })

  it('renders millions with an M suffix', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(3_450_000)).toBe('3.5M')
    expect(formatTokens(42_000_000)).toBe('42M')
  })

  it('clamps non-finite / negative to 0', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('formatCost', () => {
  it('renders zero and sub-cent amounts', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(-1)).toBe('$0')
    expect(formatCost(0.004)).toBe('<$0.01')
  })

  it('renders fractional cents and small dollars to 2dp', () => {
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(3.5)).toBe('$3.50')
    expect(formatCost(9.99)).toBe('$9.99')
  })

  it('compacts larger amounts', () => {
    expect(formatCost(42)).toBe('$42')
    expect(formatCost(42.6)).toBe('$42.6')
    expect(formatCost(1234)).toBe('$1.2k')
    expect(formatCost(99999)).toBe('$100k')
  })
})
