import { describe, it, expect } from 'vitest'
import type { ChatBlock } from '../shared/contract.js'
import { blocksFromContent, toolResultContentToParts } from './chatBlockShared.js'

describe('blocksFromContent', () => {
  it('wraps non-empty string content in a single text block', () => {
    expect(blocksFromContent('hi', () => [])).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('returns [] for empty string content', () => {
    expect(blocksFromContent('', () => [])).toEqual([])
  })

  it('returns [] for content that is neither a string nor an array', () => {
    expect(blocksFromContent(42, () => [])).toEqual([])
    expect(blocksFromContent(null, () => [])).toEqual([])
    expect(blocksFromContent({ foo: 'bar' }, () => [])).toEqual([])
  })

  it('returns [] for an empty array', () => {
    expect(blocksFromContent([], () => [])).toEqual([])
  })

  it('flattens a mapper that returns multiple blocks per item', () => {
    const mapRaw = (raw: unknown): ChatBlock[] => [
      { type: 'text', text: `${raw}-a` },
      { type: 'text', text: `${raw}-b` },
    ]
    expect(blocksFromContent(['x', 'y'], mapRaw)).toEqual([
      { type: 'text', text: 'x-a' },
      { type: 'text', text: 'x-b' },
      { type: 'text', text: 'y-a' },
      { type: 'text', text: 'y-b' },
    ])
  })

  it('supports the nullable-adapter pattern (0-or-1 blocks per item)', () => {
    const mapRaw = (raw: unknown): ChatBlock[] => {
      const block =
        typeof raw === 'string' && raw.length > 0 ? { type: 'text' as const, text: raw } : null
      return block ? [block] : []
    }
    expect(blocksFromContent(['a', '', 'b'], mapRaw)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
  })
})

describe('toolResultContentToParts', () => {
  it('returns string content verbatim with no images', () => {
    expect(toolResultContentToParts('plain', () => null)).toEqual({ text: 'plain', images: [] })
  })

  it('returns empty text/images for content that is neither string nor array', () => {
    expect(toolResultContentToParts(42, () => null)).toEqual({ text: '', images: [] })
    expect(toolResultContentToParts(null, () => null)).toEqual({ text: '', images: [] })
    expect(toolResultContentToParts(undefined, () => null)).toEqual({ text: '', images: [] })
  })

  it('joins string parts and object text parts, skipping unrecognized parts', () => {
    const result = toolResultContentToParts(
      ['line one', { type: 'text', text: 'line two' }, { type: 'mystery' }, 42],
      () => null,
    )
    expect(result).toEqual({ text: 'line one\nline two', images: [] })
  })

  it('filters out empty text parts when joining', () => {
    const result = toolResultContentToParts(['a', '', 'b'], () => null)
    expect(result.text).toBe('a\nb')
  })

  it('pulls an image part into .images via the injected extractor when it returns non-null', () => {
    const imageFromPart = (part: Record<string, unknown>): ChatBlock | null =>
      typeof part['data'] === 'string' ? { type: 'image', data: part['data'] } : null
    const result = toolResultContentToParts(
      [
        { type: 'text', text: 'here' },
        { type: 'image', data: 'AAAA' },
      ],
      imageFromPart,
    )
    expect(result).toEqual({
      text: 'here',
      images: [{ type: 'image', data: 'AAAA' }],
    })
  })

  it('drops an image part when the injected extractor returns null', () => {
    const result = toolResultContentToParts(
      [
        { type: 'text', text: 'here' },
        { type: 'image', data: 'AAAA' },
      ],
      () => null,
    )
    expect(result).toEqual({ text: 'here', images: [] })
  })
})
