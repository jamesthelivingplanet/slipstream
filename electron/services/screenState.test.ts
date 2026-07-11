/**
 * ScreenState unit tests — pure logic (headless xterm + serialize addon, no
 * native/Electron deps).
 */

import { describe, it, expect } from 'vitest'
import { ScreenState, serializeScrollback } from './screenState.js'

describe('ScreenState', () => {
  it('snapshot before any output reports seq 0, never negative (would wedge the client gate)', async () => {
    const screen = new ScreenState(80, 24)
    const snap = await screen.snapshot()
    expect(typeof snap.data).toBe('string')
    expect(snap.seq).toBe(0)
    screen.dispose()
  })

  it('snapshot contains written text and seq equals the last pushed seq', async () => {
    const screen = new ScreenState(80, 24)
    screen.write('hello world', 11)
    const snap = await screen.snapshot()
    expect(snap.data).toContain('hello world')
    expect(snap.seq).toBe(11)
    screen.dispose()
  })

  it('reflects writes made after an earlier snapshot in a later one', async () => {
    const screen = new ScreenState(80, 24)
    screen.write('first', 5)
    const snap1 = await screen.snapshot()
    expect(snap1.data).toContain('first')
    expect(snap1.seq).toBe(5)

    screen.write(' second', 12)
    const snap2 = await screen.snapshot()
    expect(snap2.data).toContain('first second')
    expect(snap2.seq).toBe(12)
    screen.dispose()
  })

  it('resize then snapshot does not throw and still contains content', async () => {
    const screen = new ScreenState(80, 24)
    screen.write('resizable content', 17)
    expect(() => screen.resize(40, 12)).not.toThrow()
    const snap = await screen.snapshot()
    expect(snap.data).toContain('resizable content')
    screen.dispose()
  })

  it('resize clamps degenerate dimensions instead of throwing', async () => {
    const screen = new ScreenState(80, 24)
    expect(() => screen.resize(0, 0)).not.toThrow()
    expect(() => screen.resize(-5, -5)).not.toThrow()
    const snap = await screen.snapshot()
    expect(snap).toBeDefined()
    screen.dispose()
  })

  describe('serializeScrollback — head-truncated mid-escape-sequence', () => {
    it('preserves intact later text and drops the orphaned sequence tail once overwritten', async () => {
      // A scrollback file's head can be trimmed to an arbitrary character
      // boundary (256 KB ring buffer, outputBuffer.ts), landing inside an
      // ANSI escape sequence. The retained fragment then starts with the
      // *tail* of that sequence (no leading ESC byte) — e.g. slicing off the
      // first 3 characters of a truecolor SGR leaves the tail below.
      const coloredHello = '\x1b[38;2;74;144;226mHello World\x1b[0m'
      const garbledHead = coloredHello.slice(3) // starts mid-sequence: '8;2;74;144;226m...'
      expect(garbledHead.startsWith('8;2;74')).toBe(true)

      // Full-screen TUIs (the agents this app drives) redraw constantly, so
      // within the same retained window there's almost always a subsequent
      // clear + repaint that overwrites whatever garbage the truncated head
      // produced — that's what actually "heals" the truncation, not magic
      // parsing of the partial sequence.
      const raw = garbledHead + '\x1b[2J\x1b[H' + 'Clean Text'

      const serialized = await serializeScrollback(raw, 80, 24)
      expect(serialized).toContain('Clean Text')
      expect(serialized).not.toContain('8;2;74')

      // Cross-check by feeding the serialized output through a fresh mirror.
      const verify = new ScreenState(80, 24)
      verify.write(serialized, 0)
      const snap = await verify.snapshot()
      expect(snap.data).toContain('Clean Text')
      verify.dispose()
    })
  })

  describe('cursor-movement-heavy input — serializes screen state, not history', () => {
    it('a clear + rewrite drops the pre-clear text from the serialized output', async () => {
      const screen = new ScreenState(80, 24)
      screen.write('first frame line one\r\nfirst frame line two', 40)
      // Full clear + cursor home, then a fresh frame — mirrors a TUI repaint.
      screen.write('\x1b[2J\x1b[Hsecond frame', 53)

      const snap = await screen.snapshot()
      expect(snap.data).toContain('second frame')
      expect(snap.data).not.toContain('first frame')
      screen.dispose()
    })
  })
})
