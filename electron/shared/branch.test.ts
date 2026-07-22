import { describe, it, expect } from 'vitest'
import { slug, branchFor, isSafeSlug } from './branch.js'

describe('slug', () => {
  it('lowercases and hyphenates, capped at 4 words', () => {
    expect(slug('Figure Out How To Do This')).toBe('figure-out-how-to')
  })

  it('strips non-alphanumeric characters', () => {
    expect(slug('Fix: the "../foo" bug!')).toBe('fix-the-foo-bug')
  })
})

describe('branchFor', () => {
  it('joins tid and slugged title', () => {
    expect(branchFor('FLO-5', 'Figure out how to do this')).toBe('FLO-5-figure-out-how-to')
  })

  it('throws for a tid containing a path traversal segment', () => {
    expect(() => branchFor('../../etc', 'Fix bug')).toThrow(/Invalid ticket id/)
  })

  it('throws for a tid containing a slash', () => {
    expect(() => branchFor('FLO/129', 'Fix bug')).toThrow(/Invalid ticket id/)
  })

  it('throws for an absolute-path tid', () => {
    expect(() => branchFor('/etc/passwd', 'Fix bug')).toThrow(/Invalid ticket id/)
  })
})

describe('isSafeSlug', () => {
  it('accepts plain ticket/branch slugs', () => {
    expect(isSafeSlug('FLO-129')).toBe(true)
    expect(isSafeSlug('FLO-129-fix-the-thing')).toBe(true)
    expect(isSafeSlug('T-1')).toBe(true)
  })

  it('rejects path traversal payloads', () => {
    expect(isSafeSlug('..')).toBe(false)
    expect(isSafeSlug('../../etc/passwd')).toBe(false)
    expect(isSafeSlug('foo/../../bar')).toBe(false)
  })

  it('rejects absolute paths', () => {
    expect(isSafeSlug('/etc/passwd')).toBe(false)
    expect(isSafeSlug('\\\\server\\share')).toBe(false)
  })

  it('rejects values containing slashes', () => {
    expect(isSafeSlug('foo/bar')).toBe(false)
    expect(isSafeSlug('foo\\bar')).toBe(false)
  })

  it('rejects empty strings and non-strings', () => {
    expect(isSafeSlug('')).toBe(false)
    expect(isSafeSlug(undefined)).toBe(false)
    expect(isSafeSlug(null)).toBe(false)
    expect(isSafeSlug(42)).toBe(false)
  })
})
