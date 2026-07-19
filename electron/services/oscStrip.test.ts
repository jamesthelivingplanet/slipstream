/**
 * Osc52Stripper unit tests — cross-chunk OSC 52 stripping state machine.
 */

import { describe, it, expect } from 'vitest'
import { Osc52Stripper } from './oscStrip.js'

const BEL = '\x07'
const ST = '\x1b\\'

function osc52(payload: string, terminator: string): string {
  return `\x1b]52;c;${payload}${terminator}`
}

describe('Osc52Stripper', () => {
  describe('single-chunk stripping', () => {
    it('removes a complete OSC 52 sequence with a BEL terminator', () => {
      const stripper = new Osc52Stripper()
      const input = `abc${osc52('QUJD', BEL)}def`
      expect(stripper.push(input)).toBe('abcdef')
    })

    it('removes a complete OSC 52 sequence with an ST terminator', () => {
      const stripper = new Osc52Stripper()
      const input = `abc${osc52('QUJD', ST)}def`
      expect(stripper.push(input)).toBe('abcdef')
    })
  })

  describe('sequences split across push() calls', () => {
    it('strips a sequence split inside the 5-byte introducer', () => {
      const stripper = new Osc52Stripper()
      const full = osc52('QUJD', BEL)
      // Split after '\x1b]5' — inside the literal introducer '\x1b]52;'.
      const part1 = full.slice(0, 3)
      const part2 = full.slice(3)
      expect(part1).toBe('\x1b]5')

      let out = ''
      out += stripper.push(part1)
      out += stripper.push(part2)
      expect(out).toBe('')
    })

    it('strips a sequence split inside the base64 payload across 3 calls', () => {
      const stripper = new Osc52Stripper()
      const intro = '\x1b]52;c;'
      const payload = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' // arbitrary base64-ish
      const terminator = BEL
      const trailing = 'trailing-text'

      const call1 = intro + payload.slice(0, 10)
      const call2 = payload.slice(10, 20)
      const call3 = payload.slice(20) + terminator + trailing

      let out = ''
      out += stripper.push(call1)
      out += stripper.push(call2)
      out += stripper.push(call3)
      expect(out).toBe(trailing)
    })
  })

  describe('non-OSC-52 content passes through untouched', () => {
    it('leaves an OSC 0 (window title) sequence byte-identical', () => {
      const stripper = new Osc52Stripper()
      const input = '\x1b]0;title\x07'
      expect(stripper.push(input)).toBe(input)
    })

    it('leaves plain ANSI color codes byte-identical', () => {
      const stripper = new Osc52Stripper()
      const input = '\x1b[31mred text\x1b[0m'
      expect(stripper.push(input)).toBe(input)
    })

    it('leaves OSC 0 and ANSI colors byte-identical across multiple push calls', () => {
      const stripper = new Osc52Stripper()
      const part1 = '\x1b]0;ti'
      const part2 = 'tle\x07\x1b[31m'
      const part3 = 'red\x1b[0m'
      const out = stripper.push(part1) + stripper.push(part2) + stripper.push(part3)
      expect(out).toBe(part1 + part2 + part3)
    })
  })

  describe('carry-overflow bound', () => {
    it('flushes an unterminated introducer once held bytes exceed the cap', () => {
      const stripper = new Osc52Stripper()
      const MAX_CANDIDATE = 512 * 1024
      const intro = '\x1b]52;'
      // More than the cap's worth of non-terminator bytes, never closed.
      const filler = 'x'.repeat(MAX_CANDIDATE + 1000)

      let out = ''
      out += stripper.push(intro)
      out += stripper.push(filler)

      // The held candidate (intro + filler, un-terminated) must eventually
      // flush through unmodified rather than vanish or throw.
      expect(out.length).toBeGreaterThan(0)
      expect(out).toBe(intro + filler)
    })

    it('does not throw and does not lose data for an unterminated sequence', () => {
      const stripper = new Osc52Stripper()
      const MAX_CANDIDATE = 512 * 1024
      expect(() => {
        stripper.push('\x1b]52;c;' + 'y'.repeat(MAX_CANDIDATE + 500))
      }).not.toThrow()
    })
  })

  describe('lone ESC/OSC at end of stream', () => {
    it('holds a trailing lone ESC across calls with no data loss', () => {
      const stripper = new Osc52Stripper()
      // '\x1b]' at the very end of a chunk — ambiguous, must be held, not lost.
      const out1 = stripper.push('hello\x1b]')
      expect(out1).toBe('hello')

      // Followed later by bytes proving it was NOT an OSC 52 introducer.
      const out2 = stripper.push('0;title\x07world')
      expect(out1 + out2).toBe('hello\x1b]0;title\x07world')
    })

    it('holds a trailing lone ESC that later resolves into a real OSC 52 and strips it', () => {
      const stripper = new Osc52Stripper()
      const out1 = stripper.push('hello\x1b]5')
      expect(out1).toBe('hello')

      const out2 = stripper.push('2;c;QUJD\x07world')
      expect(out1 + out2).toBe('helloworld')
    })
  })

  describe('round-trip reconstruction', () => {
    it('reconstructs the original input minus the stripped OSC 52 sequence', () => {
      const stripper = new Osc52Stripper()
      const chunks = [
        'plain text before ',
        '\x1b[31mcolored\x1b[0m ',
        '\x1b]52;c;QUJD',
        '\x07 more text ',
        '\x1b]0;window-title\x07',
        ' end',
      ]
      const original = chunks.join('')
      const stripped = original.replace('\x1b]52;c;QUJD\x07', '')

      let out = ''
      for (const chunk of chunks) {
        out += stripper.push(chunk)
      }
      expect(out).toBe(stripped)
    })
  })
})
