import { describe, it, expect } from 'vitest'
import { decodeOsc52 } from './osc52.js'

describe('decodeOsc52', () => {
  it('decodes a happy-path clipboard payload', () => {
    expect(decodeOsc52('c;aGVsbG8=')).toBe('hello')
  })

  it('decodes a payload with empty targets', () => {
    expect(decodeOsc52(';aGVsbG8=')).toBe('hello')
  })

  it('returns null for a clipboard-read query payload', () => {
    expect(decodeOsc52('c;?')).toBeNull()
  })

  it('returns null for malformed base64', () => {
    expect(decodeOsc52('c;not-valid-base64!!!')).toBeNull()
  })

  it('returns null when the payload is missing a semicolon', () => {
    expect(decodeOsc52('aGVsbG8=')).toBeNull()
  })

  it('roundtrips multibyte UTF-8 text', () => {
    const original = 'héllo 世界 🚀'
    const b64 = Buffer.from(original, 'utf8').toString('base64')
    expect(decodeOsc52(`c;${b64}`)).toBe(original)
  })

  it('returns null when the decoded payload exceeds the 1 MiB cap', () => {
    const big = 'a'.repeat(1048577) // > 1 MiB decoded
    const b64 = Buffer.from(big, 'utf8').toString('base64')
    expect(decodeOsc52(`c;${b64}`)).toBeNull()
  })
})
