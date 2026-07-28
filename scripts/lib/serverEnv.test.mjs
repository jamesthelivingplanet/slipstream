import { describe, it, expect } from 'vitest'
import { applySandboxLine } from './serverEnv.mjs'

describe('applySandboxLine', () => {
  it('appends SLIPSTREAM_SANDBOX=bwrap when the key is absent', () => {
    const lines = ['SLIPSTREAM_TOKEN=abc123', 'SLIPSTREAM_BIND=127.0.0.1']
    const { lines: result, changed } = applySandboxLine(lines, 'bwrap')
    expect(changed).toBe(true)
    expect(result).toEqual([
      'SLIPSTREAM_TOKEN=abc123',
      'SLIPSTREAM_BIND=127.0.0.1',
      'SLIPSTREAM_SANDBOX=bwrap',
    ])
  })

  it('leaves an existing SLIPSTREAM_SANDBOX=none untouched even when mode is bwrap', () => {
    const lines = ['SLIPSTREAM_TOKEN=abc123', 'SLIPSTREAM_SANDBOX=none']
    const { lines: result, changed } = applySandboxLine(lines, 'bwrap')
    expect(changed).toBe(false)
    expect(result).toEqual(['SLIPSTREAM_TOKEN=abc123', 'SLIPSTREAM_SANDBOX=none'])
  })

  it('leaves an existing SLIPSTREAM_SANDBOX=bwrap untouched and does not duplicate it', () => {
    const lines = ['SLIPSTREAM_TOKEN=abc123', 'SLIPSTREAM_SANDBOX=bwrap']
    const { lines: result, changed } = applySandboxLine(lines, 'bwrap')
    expect(changed).toBe(false)
    const sandboxLines = result.filter((line) => line.startsWith('SLIPSTREAM_SANDBOX='))
    expect(sandboxLines).toHaveLength(1)
    expect(sandboxLines[0]).toBe('SLIPSTREAM_SANDBOX=bwrap')
  })

  it('never modifies or reorders the SLIPSTREAM_TOKEN line — append case', () => {
    const lines = ['SLIPSTREAM_TOKEN=abc123', 'SLIPSTREAM_BIND=127.0.0.1', 'SLIPSTREAM_PORT=7421']
    const { lines: result } = applySandboxLine(lines, 'bwrap')
    expect(result[0]).toBe('SLIPSTREAM_TOKEN=abc123')
    expect(result.indexOf('SLIPSTREAM_TOKEN=abc123')).toBe(0)
  })

  it('never modifies or reorders the SLIPSTREAM_TOKEN line — leave-alone case', () => {
    const lines = ['SLIPSTREAM_TOKEN=abc123', 'SLIPSTREAM_SANDBOX=none', 'SLIPSTREAM_PORT=7421']
    const { lines: result } = applySandboxLine(lines, 'bwrap')
    expect(result[0]).toBe('SLIPSTREAM_TOKEN=abc123')
    expect(result.indexOf('SLIPSTREAM_TOKEN=abc123')).toBe(0)
  })

  it('does not mutate the input array', () => {
    const lines = ['SLIPSTREAM_TOKEN=abc123']
    const before = [...lines]
    const { lines: result } = applySandboxLine(lines, 'bwrap')
    expect(lines).toEqual(before)
    expect(result).not.toBe(lines)
  })
})
