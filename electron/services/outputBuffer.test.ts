/**
 * OutputBuffer unit tests — pure logic, no native imports.
 */

import { describe, it, expect } from 'vitest'
import { OutputBuffer } from './outputBuffer.js'

describe('OutputBuffer', () => {
  describe('push — cumulative seq', () => {
    it('returns chunk.length as seq after first push', () => {
      const buf = new OutputBuffer()
      const seq = buf.push('hello')
      expect(seq).toBe(5)
    })

    it('accumulates seq across multiple pushes', () => {
      const buf = new OutputBuffer()
      buf.push('abc')    // 3
      buf.push('de')     // 2
      const seq = buf.push('f') // 1
      expect(seq).toBe(6)
    })
  })

  describe('snapshot — data and seq', () => {
    it('returns empty data and seq 0 before any push', () => {
      const buf = new OutputBuffer()
      expect(buf.snapshot()).toEqual({ data: '', seq: 0 })
    })

    it('returns the pushed data and current seq', () => {
      const buf = new OutputBuffer()
      buf.push('hello ')
      buf.push('world')
      expect(buf.snapshot()).toEqual({ data: 'hello world', seq: 11 })
    })

    it('snapshot does not mutate the buffer', () => {
      const buf = new OutputBuffer()
      buf.push('abc')
      const s1 = buf.snapshot()
      buf.push('def')
      const s2 = buf.snapshot()
      expect(s1).toEqual({ data: 'abc', seq: 3 })
      expect(s2).toEqual({ data: 'abcdef', seq: 6 })
    })
  })

  describe('bounding — 256 KB cap', () => {
    const MAX = 256 * 1024

    it('retains only the last 256 KB when total exceeds the cap', () => {
      const buf = new OutputBuffer()
      // Push MAX+100 chars total: 'a' repeated MAX chars, then 'b' repeated 100.
      buf.push('a'.repeat(MAX))
      buf.push('b'.repeat(100))

      const snap = buf.snapshot()
      // The retained data should be MAX chars long (the tail).
      expect(snap.data.length).toBe(MAX)
      // The tail ends with the 100 'b' chars.
      expect(snap.data.endsWith('b'.repeat(100))).toBe(true)
    })

    it('seq reflects the full total even when data is trimmed', () => {
      const buf = new OutputBuffer()
      const chunk = 'x'.repeat(MAX)
      buf.push(chunk)       // seq = MAX
      buf.push('y'.repeat(200)) // seq = MAX + 200

      const snap = buf.snapshot()
      expect(snap.seq).toBe(MAX + 200)
      // Data is trimmed to MAX chars
      expect(snap.data.length).toBe(MAX)
    })

    it('push return value matches snapshot seq', () => {
      const buf = new OutputBuffer()
      const chunk1 = 'a'.repeat(MAX)
      const chunk2 = 'b'.repeat(500)
      buf.push(chunk1)
      const returnedSeq = buf.push(chunk2)
      expect(returnedSeq).toBe(buf.snapshot().seq)
    })
  })
})
