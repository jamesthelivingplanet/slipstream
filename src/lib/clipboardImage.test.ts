import { describe, it, expect } from 'vitest'
import { findClipboardImageItem } from './clipboardImage.js'

describe('findClipboardImageItem', () => {
  it('returns null when items is null/undefined', () => {
    expect(findClipboardImageItem(null)).toBeNull()
    expect(findClipboardImageItem(undefined)).toBeNull()
  })

  it('returns null when there are no file items', () => {
    expect(findClipboardImageItem([{ kind: 'string', type: 'text/plain' }])).toBeNull()
  })

  it('returns null for a non-image file item', () => {
    expect(findClipboardImageItem([{ kind: 'file', type: 'text/csv' }])).toBeNull()
  })

  it('returns the first image/* file item', () => {
    const items = [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png' },
      { kind: 'file', type: 'image/jpeg' },
    ]
    expect(findClipboardImageItem(items)).toBe(items[1])
  })

  it('ignores a kind of "file" with a non-image/* type even alongside an image item', () => {
    const items = [
      { kind: 'file', type: 'application/pdf' },
      { kind: 'file', type: 'image/gif' },
    ]
    expect(findClipboardImageItem(items)).toBe(items[1])
  })
})
