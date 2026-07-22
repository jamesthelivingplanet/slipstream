/**
 * ScrollbackStore unit tests — pure file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { ScrollbackStore } from './scrollbackStore.js'

describe('ScrollbackStore', () => {
  let tmpDir: string
  let store: ScrollbackStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollback-test-'))
    store = new ScrollbackStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('append and read', () => {
    it('saves a chunk and reads it back', () => {
      const id = randomUUID()
      store.append(id, 'hello world')
      expect(store.read(id)).toBe('hello world')
    })

    it('accumulates multiple chunks', () => {
      const id = randomUUID()
      store.append(id, 'abc')
      store.append(id, 'def')
      expect(store.read(id)).toBe('abcdef')
    })

    it('returns empty string for missing session', () => {
      expect(store.read('nonexistent')).toBe('')
    })
  })

  describe('delete', () => {
    it('removes the scrollback file', () => {
      const id = randomUUID()
      store.append(id, 'data')
      expect(store.read(id)).toBe('data')
      store.delete(id)
      expect(store.read(id)).toBe('')
    })

    it('is a no-op for missing session', () => {
      expect(() => store.delete('nonexistent')).not.toThrow()
    })

    it('also removes the persisted size file', () => {
      const id = randomUUID()
      store.append(id, 'data')
      store.setSize(id, 120, 40)
      expect(store.getSize(id)).toEqual({ cols: 120, rows: 40 })
      store.delete(id)
      expect(store.getSize(id)).toBeNull()
    })
  })

  describe('setSize / getSize — persisted terminal geometry', () => {
    it('round-trips a persisted size', () => {
      const id = randomUUID()
      store.setSize(id, 100, 32)
      expect(store.getSize(id)).toEqual({ cols: 100, rows: 32 })
    })

    it('overwrites a previously persisted size', () => {
      const id = randomUUID()
      store.setSize(id, 80, 30)
      store.setSize(id, 200, 55)
      expect(store.getSize(id)).toEqual({ cols: 200, rows: 55 })
    })

    it('returns null for an unknown session id', () => {
      expect(store.getSize('nonexistent')).toBeNull()
    })

    it('returns null for a corrupt size file', () => {
      const id = randomUUID()
      const file = path.join(tmpDir, 'scrollback', `${id}.size.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'not json', 'utf8')
      expect(store.getSize(id)).toBeNull()
    })

    it('returns null for non-positive dimensions', () => {
      const id = randomUUID()
      const file = path.join(tmpDir, 'scrollback', `${id}.size.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ cols: 0, rows: -1 }), 'utf8')
      expect(store.getSize(id)).toBeNull()
    })
  })

  describe('bounding — high-water truncation', () => {
    const MAX = 256 * 1024
    const HIGH_WATER = MAX * 2

    it('does NOT truncate while below the high-water mark (append-only)', () => {
      const id = randomUUID()
      // MAX + 100 is above the old per-append cap but below 2× MAX, so the
      // store must leave the file intact — the whole point of FLO-134 is that
      // a normal-sized chunk no longer triggers a read-modify-rewrite.
      store.append(id, 'a'.repeat(MAX))
      store.append(id, 'b'.repeat(100))
      const data = store.read(id)
      expect(data.length).toBe(MAX + 100)
      expect(data.endsWith('b'.repeat(100))).toBe(true)
    })

    it('re-bounds to the MAX_CHARS tail once the high-water mark is crossed', () => {
      const id = randomUUID()
      store.append(id, 'a'.repeat(MAX)) // under high-water — no truncation
      store.append(id, 'b'.repeat(MAX + 1)) // total > HIGH_WATER → re-bound
      const data = store.read(id)
      expect(data.length).toBe(MAX)
      // The last MAX chars written are all 'b's; every 'a' is dropped.
      expect(data).toBe('b'.repeat(MAX))
    })

    it('drops the head and keeps the exact tail across the boundary', () => {
      const id = randomUUID()
      store.append(id, 'a'.repeat(MAX)) // MAX of 'a'
      store.append(id, 'b'.repeat(MAX)) // exactly HIGH_WATER — not yet over
      store.append(id, 'b'.repeat(1)) // +1 → over → re-bound to MAX tail
      const data = store.read(id)
      expect(data.length).toBe(MAX)
      expect(data).toBe('b'.repeat(MAX))
    })

    it('keeps the file bounded across many small chunks (amortized rewrite)', () => {
      const id = randomUUID()
      // A chatty build: 5× MAX fed in 1 KB chunks. The file must stay
      // bounded by the high-water mark and hold only the recent tail — never
      // the full 5× MAX — while doing the rewrite at most ~once per MAX.
      const chunk = 'c'.repeat(1024)
      const total = MAX * 5
      for (let i = 0; i < total / chunk.length; i += 1) store.append(id, chunk)
      const data = store.read(id)
      expect(data.length).toBeLessThanOrEqual(HIGH_WATER)
      expect(data.length).toBeLessThan(total)
      expect(data).toBe('c'.repeat(data.length))
    })

    it('keeps data under MAX_CHARS for smaller writes', () => {
      const id = randomUUID()
      store.append(id, 'small data')
      const data = store.read(id)
      expect(data.length).toBeLessThanOrEqual(MAX)
      expect(data).toBe('small data')
    })

    it('a fresh store seeds its size cache from a pre-existing file (resume)', () => {
      // On session restart, launch() builds a NEW ScrollbackStore but the
      // prior run's log is still on disk; new PTY chunks append to it. The
      // in-memory size cache must seed from that existing file so the
      // high-water check still trips correctly (and doesn't double-count
      // the first new chunk).
      const id = randomUUID()
      store.append(id, 'a'.repeat(MAX)) // prior run leaves MAX on disk

      const resumed = new ScrollbackStore(tmpDir)
      resumed.append(id, 'b'.repeat(MAX + 1)) // new chunk pushes past HIGH_WATER
      const data = resumed.read(id)
      expect(data.length).toBe(MAX)
      expect(data).toBe('b'.repeat(MAX))
    })
  })

  describe('OSC 52 stripping on append', () => {
    it('strips a complete OSC 52 sequence, keeping surrounding plain text', () => {
      const id = randomUUID()
      store.append(id, 'before\x1b]52;c;QUJD\x07after')
      expect(store.read(id)).toBe('beforeafter')
    })

    it('strips an OSC 52 sequence split across two append() calls', () => {
      const id = randomUUID()
      store.append(id, 'before\x1b]5')
      store.append(id, '2;c;QUJD\x07after')
      expect(store.read(id)).toBe('beforeafter')
    })

    it('does not false-positive-strip plain content that merely resembles an introducer', () => {
      const id = randomUUID()
      store.append(id, 'plain text \x1b]5 more text')
      expect(store.read(id)).toBe('plain text \x1b]5 more text')
    })

    it('keeps per-session stripper state independent across two sessions', () => {
      const idA = randomUUID()
      const idB = randomUUID()

      // Both sessions start an OSC 52 sequence split mid-introducer; make
      // sure interleaving append() calls for different ids doesn't cross-wire
      // the in-flight candidate buffers.
      store.append(idA, 'A1\x1b]5')
      store.append(idB, 'B1\x1b]52;c;QUJD\x07B2')
      store.append(idA, '2;c;QUJD\x07A2')

      expect(store.read(idA)).toBe('A1A2')
      expect(store.read(idB)).toBe('B1B2')
    })

    it('is a no-op (no file created) when the chunk strips to empty', () => {
      const id = randomUUID()
      store.append(id, '\x1b]52;c;QUJD\x07') // pure OSC 52 → stripped to ''
      expect(store.read(id)).toBe('')
      expect(fs.existsSync(path.join(tmpDir, 'scrollback', `${id}.log`))).toBe(false)
    })
  })
})
