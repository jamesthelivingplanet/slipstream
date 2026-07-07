import { describe, it, expect } from 'vitest'
import { parseOutcomeSentinel } from './outcomeSentinel.js'

describe('parseOutcomeSentinel', () => {
  it('parses a valid "success" sentinel', () => {
    const result = parseOutcomeSentinel(
      JSON.stringify({ result: 'success', summary: 'Fixed the bug', ts: 123 }),
    )
    expect(result).toEqual({ result: 'success', summary: 'Fixed the bug', ts: 123 })
  })

  it('parses a valid "partial" sentinel', () => {
    const result = parseOutcomeSentinel(
      JSON.stringify({ result: 'partial', summary: 'Some progress', ts: 456 }),
    )
    expect(result).toEqual({ result: 'partial', summary: 'Some progress', ts: 456 })
  })

  it('parses a valid "failure" sentinel', () => {
    const result = parseOutcomeSentinel(
      JSON.stringify({ result: 'failure', summary: 'Could not reproduce', ts: 789 }),
    )
    expect(result).toEqual({ result: 'failure', summary: 'Could not reproduce', ts: 789 })
  })

  it('preserves optional details when present', () => {
    const result = parseOutcomeSentinel(
      JSON.stringify({
        result: 'success',
        summary: 'Done',
        details: '- decision A\n- follow-up B',
        ts: 1,
      }),
    )
    expect(result).toEqual({
      result: 'success',
      summary: 'Done',
      details: '- decision A\n- follow-up B',
      ts: 1,
    })
  })

  it('omits details when absent', () => {
    const result = parseOutcomeSentinel(
      JSON.stringify({ result: 'success', summary: 'Done', ts: 1 }),
    )
    expect(result?.details).toBeUndefined()
  })

  it('returns null for malformed JSON', () => {
    expect(parseOutcomeSentinel('{not json')).toBeNull()
  })

  it('returns null for an unknown result', () => {
    expect(
      parseOutcomeSentinel(JSON.stringify({ result: 'bogus', summary: 'x', ts: 1 })),
    ).toBeNull()
  })

  it('returns null for an empty summary', () => {
    expect(
      parseOutcomeSentinel(JSON.stringify({ result: 'success', summary: '', ts: 1 })),
    ).toBeNull()
  })

  it('returns null for a missing summary', () => {
    expect(parseOutcomeSentinel(JSON.stringify({ result: 'success', ts: 1 }))).toBeNull()
  })

  it('returns null for a missing ts', () => {
    expect(parseOutcomeSentinel(JSON.stringify({ result: 'success', summary: 'Done' }))).toBeNull()
  })

  it('returns null for a non-number ts', () => {
    expect(
      parseOutcomeSentinel(JSON.stringify({ result: 'success', summary: 'Done', ts: 'soon' })),
    ).toBeNull()
  })

  it('truncates an over-long summary to 4000 chars', () => {
    const longSummary = 'x'.repeat(5000)
    const result = parseOutcomeSentinel(
      JSON.stringify({ result: 'success', summary: longSummary, ts: 1 }),
    )
    expect(result?.summary.length).toBe(4000)
  })

  it('truncates over-long details to 32000 chars', () => {
    const longDetails = 'y'.repeat(40000)
    const result = parseOutcomeSentinel(
      JSON.stringify({ result: 'success', summary: 'ok', details: longDetails, ts: 1 }),
    )
    expect(result?.details?.length).toBe(32000)
  })
})
