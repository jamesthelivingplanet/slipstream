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
})