import { describe, it, expect } from 'vitest'
import {
  walkMessage,
  fieldsOf,
  firstField,
  subMessage,
  getPath,
  getPathFirst,
  asText,
  asVarintNumber,
} from './protoWalk.js'

// Hand-built protobuf wire-format encoders — deliberately NOT reusing
// anything from protoWalk.ts, so these tests exercise the walker against an
// independent encoding of the spec rather than round-tripping through the
// same code.

function encodeVarint(n: bigint | number): Buffer {
  let v = typeof n === 'bigint' ? n : BigInt(n)
  if (v < 0n) throw new Error('test helper only encodes non-negative values')
  const bytes: number[] = []
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    bytes.push(b)
  } while (v > 0n)
  return Buffer.from(bytes)
}

function tag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType)
}

function varintField(fieldNumber: number, value: number | bigint): Buffer {
  return Buffer.concat([tag(fieldNumber, 0), encodeVarint(value)])
}

function lenField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 2), encodeVarint(payload.length), payload])
}

function textField(fieldNumber: number, text: string): Buffer {
  return lenField(fieldNumber, Buffer.from(text, 'utf8'))
}

function fixed32Field(fieldNumber: number, raw: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 5), raw])
}

function fixed64Field(fieldNumber: number, raw: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 1), raw])
}

describe('walkMessage', () => {
  it('parses a varint field', () => {
    const buf = varintField(1, 150)
    const msg = walkMessage(buf)
    expect(msg.fields).toEqual([{ fieldNumber: 1, wireType: 0, varint: 150n }])
  })

  it('parses a large varint spanning multiple continuation bytes', () => {
    const big = 123456789012345n
    const buf = varintField(3, big)
    const msg = walkMessage(buf)
    expect(msg.fields[0]).toEqual({ fieldNumber: 3, wireType: 0, varint: big })
  })

  it('parses a length-delimited text field', () => {
    const buf = textField(2, 'hello world')
    const msg = walkMessage(buf)
    expect(asText(firstField(msg, 2))).toBe('hello world')
  })

  it('parses a fixed64 field, keeping raw bytes', () => {
    const raw = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const buf = fixed64Field(9, raw)
    const msg = walkMessage(buf)
    expect(msg.fields).toEqual([{ fieldNumber: 9, wireType: 1, raw }])
  })

  it('parses a fixed32 field, keeping raw bytes', () => {
    const raw = Buffer.from([9, 8, 7, 6])
    const buf = fixed32Field(4, raw)
    const msg = walkMessage(buf)
    expect(msg.fields).toEqual([{ fieldNumber: 4, wireType: 5, raw }])
  })

  it('parses multiple fields in order', () => {
    const buf = Buffer.concat([varintField(1, 5), textField(2, 'x'), varintField(1, 6)])
    const msg = walkMessage(buf)
    expect(msg.fields.map((f) => [f.fieldNumber, f.wireType])).toEqual([
      [1, 0],
      [2, 2],
      [1, 0],
    ])
  })

  it('preserves repeated fields as separate entries, readable via fieldsOf', () => {
    const buf = Buffer.concat([varintField(7, 1), varintField(7, 2), varintField(7, 3)])
    const msg = walkMessage(buf)
    expect(fieldsOf(msg, 7).map((f) => f.varint)).toEqual([1n, 2n, 3n])
  })

  it('recurses into a nested submessage', () => {
    const inner = Buffer.concat([textField(2, 'nested text'), varintField(3, 42)])
    const outer = lenField(19, inner)
    const msg = walkMessage(outer)
    const sub = subMessage(firstField(msg, 19))
    expect(sub).not.toBeNull()
    expect(asText(firstField(sub!, 2))).toBe('nested text')
    expect(asVarintNumber(firstField(sub!, 3))).toBe(42)
  })

  it('walks a multi-level dotted path via getPath/getPathFirst', () => {
    const innermost = textField(1, 'deep value')
    const middle = lenField(3, innermost)
    const outer = lenField(19, middle)
    const msg = walkMessage(outer)
    expect(asText(getPathFirst(msg, 19, 3, 1))).toBe('deep value')
    expect(getPath(msg, 19, 3, 1)).toHaveLength(1)
  })

  it('getPath returns [] when an intermediate hop is missing', () => {
    const msg = walkMessage(textField(5, 'irrelevant'))
    expect(getPath(msg, 19, 3, 1)).toEqual([])
  })

  it('getPath returns [] for an empty path', () => {
    const msg = walkMessage(varintField(1, 1))
    expect(getPath(msg)).toEqual([])
  })

  it('never throws on a truncated tag byte (high bit set, buffer ends)', () => {
    const buf = Buffer.from([0x80]) // continuation bit set, no next byte
    expect(() => walkMessage(buf)).not.toThrow()
    expect(walkMessage(buf).fields).toEqual([])
  })

  it('stops cleanly and keeps prior fields when a later field is truncated', () => {
    const good = varintField(1, 7)
    // length-delimited field claiming 50 bytes but supplying none
    const truncated = Buffer.concat([tag(2, 2), encodeVarint(50)])
    const buf = Buffer.concat([good, truncated])
    const msg = walkMessage(buf)
    expect(msg.fields).toEqual([{ fieldNumber: 1, wireType: 0, varint: 7n }])
  })

  it('never throws on a length-delimited field whose declared length overruns the buffer', () => {
    const buf = Buffer.concat([tag(1, 2), encodeVarint(9999), Buffer.from([1, 2, 3])])
    expect(() => walkMessage(buf)).not.toThrow()
    expect(walkMessage(buf).fields).toEqual([])
  })

  it('never throws on a truncated varint value (10 continuation bytes, no terminator)', () => {
    const buf = Buffer.concat([tag(1, 0), Buffer.alloc(10, 0x80)])
    expect(() => walkMessage(buf)).not.toThrow()
    expect(walkMessage(buf).fields).toEqual([])
  })

  it('never throws on completely random bytes', () => {
    const buf = Buffer.from([0xff, 0x00, 0x13, 0x9a, 0x02, 0x7f, 0xee, 0x11])
    expect(() => walkMessage(buf)).not.toThrow()
  })

  it('never throws on an empty buffer', () => {
    expect(walkMessage(Buffer.alloc(0))).toEqual({ fields: [] })
  })

  it('stops the walk on a deprecated group wire type (3)', () => {
    const good = varintField(1, 1)
    const groupStart = tag(2, 3) // wireType 3 has no length — can't be skipped
    const buf = Buffer.concat([good, groupStart, varintField(3, 9)])
    const msg = walkMessage(buf)
    expect(msg.fields).toEqual([{ fieldNumber: 1, wireType: 0, varint: 1n }])
  })

  it('stops the walk when the field number is out of range', () => {
    // field number 0 is never valid — decodes from a tag byte of 0x00
    const buf = Buffer.concat([Buffer.from([0x00]), varintField(1, 1)])
    const msg = walkMessage(buf)
    expect(msg.fields).toEqual([])
  })
})

describe('asText', () => {
  it('returns "" for an empty length-delimited field (vacuously printable)', () => {
    const msg = walkMessage(lenField(1, Buffer.alloc(0)))
    expect(asText(firstField(msg, 1))).toBe('')
  })

  it('rejects non-UTF-8 binary bytes', () => {
    // Invalid UTF-8: a lone continuation byte with no lead byte.
    const raw = Buffer.from([0x80, 0x81, 0x82, 0xff, 0xfe])
    const msg = walkMessage(lenField(1, raw))
    expect(asText(firstField(msg, 1))).toBeNull()
  })

  it('rejects a field dominated by control characters even if technically valid UTF-8', () => {
    const raw = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x1c, 0x1d, 0x1e, 0x1f])
    const msg = walkMessage(lenField(1, raw))
    expect(asText(firstField(msg, 1))).toBeNull()
  })

  it('accepts text mixed with a small amount of whitespace/newlines', () => {
    const msg = walkMessage(textField(1, 'line one\nline two\ttabbed'))
    expect(asText(firstField(msg, 1))).toBe('line one\nline two\ttabbed')
  })

  it('respects a custom minPrintableRatio', () => {
    // 4 printable + 1 control char out of 5 = 80% printable.
    const raw = Buffer.concat([Buffer.from('abcd', 'utf8'), Buffer.from([0x01])])
    const msg = walkMessage(lenField(1, raw))
    expect(asText(firstField(msg, 1), 0.9)).toBeNull()
    expect(asText(firstField(msg, 1), 0.5)).not.toBeNull()
  })

  it('returns null for a missing field', () => {
    const msg = walkMessage(varintField(1, 1))
    expect(asText(firstField(msg, 99))).toBeNull()
  })

  it('returns null for a non-length-delimited field', () => {
    const msg = walkMessage(varintField(1, 42))
    expect(asText(firstField(msg, 1))).toBeNull()
  })
})

describe('asVarintNumber', () => {
  it('returns the numeric value for an in-range varint', () => {
    const msg = walkMessage(varintField(1, 12345))
    expect(asVarintNumber(firstField(msg, 1))).toBe(12345)
  })

  it('returns null when the value exceeds Number.MAX_SAFE_INTEGER', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 100n
    const msg = walkMessage(varintField(1, huge))
    expect(asVarintNumber(firstField(msg, 1))).toBeNull()
  })

  it('returns null for a missing or wrong-wireType field', () => {
    const msg = walkMessage(textField(1, 'x'))
    expect(asVarintNumber(firstField(msg, 1))).toBeNull()
    expect(asVarintNumber(firstField(msg, 99))).toBeNull()
  })
})
