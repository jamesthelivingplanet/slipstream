import { describe, it, expect } from 'vitest'
import { parseStatusSentinel } from './statusSentinel.js'

describe('parseStatusSentinel', () => {
  it('parses a valid "needs" sentinel', () => {
    const result = parseStatusSentinel(JSON.stringify({ state: 'needs', ts: 123 }))
    expect(result).toEqual({ state: 'needs', ts: 123 })
  })

  it('parses a valid "done" sentinel', () => {
    const result = parseStatusSentinel(JSON.stringify({ state: 'done', ts: 456 }))
    expect(result).toEqual({ state: 'done', ts: 456 })
  })

  it('parses a valid "running" sentinel', () => {
    const result = parseStatusSentinel(JSON.stringify({ state: 'running', ts: 789 }))
    expect(result).toEqual({ state: 'running', ts: 789 })
  })

  it('returns null for malformed JSON', () => {
    expect(parseStatusSentinel('{not json')).toBeNull()
  })

  it('returns null for an unknown state', () => {
    expect(parseStatusSentinel(JSON.stringify({ state: 'bogus', ts: 1 }))).toBeNull()
  })

  it('returns null for a missing ts', () => {
    expect(parseStatusSentinel(JSON.stringify({ state: 'needs' }))).toBeNull()
  })

  it('returns null for a non-number ts', () => {
    expect(parseStatusSentinel(JSON.stringify({ state: 'needs', ts: 'soon' }))).toBeNull()
  })

  it('preserves an optional message when present', () => {
    const result = parseStatusSentinel(JSON.stringify({ state: 'needs', ts: 1, message: 'blocked on input' }))
    expect(result).toEqual({ state: 'needs', ts: 1, message: 'blocked on input' })
  })

  it('omits message when absent', () => {
    const result = parseStatusSentinel(JSON.stringify({ state: 'done', ts: 1 }))
    expect(result?.message).toBeUndefined()
  })
})
