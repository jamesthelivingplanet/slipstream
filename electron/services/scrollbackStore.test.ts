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

  describe('bounding — 256 KB cap', () => {
    const MAX = 256 * 1024

    it('truncates head when total exceeds MAX_CHARS', () => {
      const id = randomUUID()
      store.append(id, 'a'.repeat(MAX))
      store.append(id, 'b'.repeat(100))

      const data = store.read(id)
      expect(data.length).toBe(MAX)
      expect(data.endsWith('b'.repeat(100))).toBe(true)
    })

    it('keeps data under MAX_CHARS for smaller writes', () => {
      const id = randomUUID()
      store.append(id, 'small data')
      const data = store.read(id)
      expect(data.length).toBeLessThanOrEqual(MAX)
      expect(data).toBe('small data')
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
  })
})
