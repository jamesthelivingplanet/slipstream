/**
 * protoWalk.ts — dependency-free protobuf WIRE FORMAT walker.
 *
 * This exists for antigravityChatMessages.ts/antigravityStore.ts (TASK-N6X4R):
 * antigravity (`agy`) persists its chat history as raw protobuf-encoded
 * blobs with NO `.proto` schema practically obtainable (the `agy` binary is
 * a stripped ~187MB Go ELF; field *names* survive as struct-tag strings but
 * enum name→number mapping could not be recovered). So instead of a real
 * protobuf library bound to a schema, this module walks the WIRE format
 * generically and lets the caller interpret specific field numbers against
 * an empirically-recovered (and explicitly best-effort) table — see the
 * module doc in antigravityChatMessages.ts for that table and its caveats.
 *
 * Wire format background (proto3 encoding,
 * https://protobuf.dev/programming-guides/encoding/): every field is a
 * `tag` varint `(fieldNumber << 3) | wireType` followed by a value whose
 * shape depends on wireType:
 *   0 (varint)       - a single LEB128-encoded integer (bool/enum/int32/
 *                       int64/uint*; sint* would additionally need zigzag
 *                       decoding, which this walker does NOT apply — the
 *                       raw unsigned value is exposed, caller's problem)
 *   1 (fixed64)      - 8 raw bytes (double/fixed64/sfixed64)
 *   2 (length-delim) - a varint length N followed by N raw bytes (string/
 *                       bytes/embedded message/packed repeated)
 *   5 (fixed32)      - 4 raw bytes (float/fixed32/sfixed32)
 * Wire types 3/4 (deprecated "group" start/end) have no length prefix and
 * can't be skipped without knowing the schema, so encountering one halts
 * the walk (see walkMessage below) rather than misparsing everything after
 * it.
 *
 * There is no way to know from the wire alone whether a wireType-2 value is
 * a string, raw bytes, or a nested message — every wireType-2 field is kept
 * as raw bytes, and `asText`/`subMessage` are separate, deliberately lossy
 * interpretations a caller opts into per field, per whatever the field
 * table says that field number ought to be. This is the load-bearing
 * design choice: a schema-less walk that guessed the "right" interpretation
 * on its own would silently render garbage as text against a build where
 * the field numbers have shifted. Better to expose raw bytes + narrow,
 * checkable interpretations than to guess.
 *
 * Total: never throws, even on truncated/malformed/adversarial input.
 * `walkMessage` stops at the first byte it can't make sense of and returns
 * every field successfully parsed before that point — a truncated tail is
 * "fewer fields recovered", not a crash.
 */

/** Maximum valid protobuf field number (2^29 - 1, wire-format limit). A tag
 *  that decodes to anything beyond this is not a legitimate protobuf field
 *  — either the input isn't protobuf at all, or we've desynced mid-walk;
 *  either way, stop rather than keep misreading. */
const MAX_FIELD_NUMBER = 0x1fffffff

/** Varints longer than 10 bytes can't encode a 64-bit value — a legitimate
 *  encoder never emits one. */
const MAX_VARINT_BYTES = 10

export type WireType = 0 | 1 | 2 | 5

export interface ParsedField {
  fieldNumber: number
  wireType: WireType
  /** wireType 0 only: the raw unsigned varint value. */
  varint?: bigint
  /** wireType 1 (8 bytes), 2 (N bytes), or 5 (4 bytes): the raw payload. */
  raw?: Buffer
}

export interface WalkedMessage {
  /** Every field in encounter order, including repeats — callers needing a
   *  specific field use fieldsOf/firstField/getPath below rather than
   *  indexing this directly. */
  fields: ParsedField[]
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } | null {
  let result = 0n
  let shift = 0n
  let pos = offset
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos >= buf.length) return null // truncated — no continuation byte available
    const byte = buf[pos]
    result |= BigInt(byte & 0x7f) << shift
    pos++
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    shift += 7n
  }
  return null // ran past 10 bytes without a terminator — not a valid varint
}

/**
 * Parse `buf` as a protobuf message body (no outer length prefix — that's
 * the caller's job when descending into a submessage; see subMessage).
 * Never throws. Stops and returns whatever was parsed so far as soon as it
 * hits a truncated tag/length/value, an out-of-range field number, or a
 * wire type (3/4/other) it can't skip without a schema.
 */
export function walkMessage(buf: Buffer): WalkedMessage {
  const fields: ParsedField[] = []
  let pos = 0

  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    if (!tag) break
    const wireType = Number(tag.value & 0x7n)
    const fieldNumber = Number(tag.value >> 3n)
    if (fieldNumber <= 0 || fieldNumber > MAX_FIELD_NUMBER) break
    pos = tag.next

    if (wireType === 0) {
      const v = readVarint(buf, pos)
      if (!v) break
      fields.push({ fieldNumber, wireType: 0, varint: v.value })
      pos = v.next
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) break
      fields.push({ fieldNumber, wireType: 1, raw: buf.subarray(pos, pos + 8) })
      pos += 8
    } else if (wireType === 2) {
      const len = readVarint(buf, pos)
      if (!len) break
      if (len.value > BigInt(Number.MAX_SAFE_INTEGER)) break // absurd length — desynced/adversarial
      const n = Number(len.value)
      pos = len.next
      if (pos + n > buf.length) break // declared length overruns the buffer — truncated
      fields.push({ fieldNumber, wireType: 2, raw: buf.subarray(pos, pos + n) })
      pos += n
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) break
      fields.push({ fieldNumber, wireType: 5, raw: buf.subarray(pos, pos + 4) })
      pos += 4
    } else {
      // wireType 3/4 (deprecated group start/end) or an undefined wire type
      // (6/7): no way to know how many bytes to skip without a schema.
      break
    }
  }

  return { fields }
}

/** All fields with this field number, in encounter order (repeated/packed
 *  fields land here as separate entries). */
export function fieldsOf(msg: WalkedMessage, fieldNumber: number): ParsedField[] {
  return msg.fields.filter((f) => f.fieldNumber === fieldNumber)
}

/** The first field with this field number, or undefined. */
export function firstField(msg: WalkedMessage, fieldNumber: number): ParsedField | undefined {
  return msg.fields.find((f) => f.fieldNumber === fieldNumber)
}

/** Attempt to parse a length-delimited field's raw bytes as a nested
 *  message. Total (walkMessage never throws), so this "succeeds" even on
 *  bytes that aren't really a submessage — it returns an empty
 *  WalkedMessage in that case, which callers can treat as "not a
 *  submessage" by checking `.fields.length`. null for a missing field or a
 *  field that isn't wireType 2 in the first place. */
export function subMessage(field: ParsedField | undefined): WalkedMessage | null {
  if (!field || field.wireType !== 2 || !field.raw) return null
  return walkMessage(field.raw)
}

/**
 * Walk a dotted field-number path down nested submessages, taking the
 * FIRST occurrence at each intermediate hop (a repeated field mid-path
 * isn't a shape any entry in the recovered mapping table uses), and
 * returning every field matching the FINAL path segment — so a repeated
 * leaf is still visible to the caller. [] when any hop is missing or isn't
 * a length-delimited (submessage-capable) field, or the path is empty.
 */
export function getPath(msg: WalkedMessage, ...path: number[]): ParsedField[] {
  if (path.length === 0) return []
  let current = msg
  for (let i = 0; i < path.length - 1; i++) {
    const next = subMessage(firstField(current, path[i]))
    if (!next) return []
    current = next
  }
  return fieldsOf(current, path[path.length - 1])
}

/** Convenience: the first field at a dotted path, or undefined. */
export function getPathFirst(msg: WalkedMessage, ...path: number[]): ParsedField | undefined {
  return getPath(msg, ...path)[0]
}

const DEFAULT_MIN_PRINTABLE_RATIO = 0.85

function isPrintableCodePoint(cp: number): boolean {
  if (cp === 0xfffd) return false // Node's UTF-8 replacement char — a decode failure marker
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true // tab / lf / cr
  if (cp < 0x20) return false // other C0 controls
  if (cp >= 0x7f && cp <= 0x9f) return false // DEL + C1 controls
  return true
}

/**
 * Decode a length-delimited field's raw bytes as UTF-8 text, but ONLY when
 * the result is convincingly printable — this is the guard against the
 * dangerous failure mode this whole reader is designed around: a schema-
 * less walk never errors, so a numeric/binary field misread as "text" would
 * render confidently-wrong content instead of visibly failing. Two checks
 * must both pass:
 *   1. Round-trip: re-encoding the decoded string must reproduce the exact
 *      same byte length. Node substitutes U+FFFD for invalid UTF-8 byte
 *      sequences, which does not round-trip to the same byte count, so this
 *      catches non-UTF-8 binary cheaply before even scanning code points.
 *   2. Printable ratio: at least `minPrintableRatio` (default 85%) of code
 *      points must be printable (see isPrintableCodePoint) — catches valid-
 *      UTF-8-but-not-really-text data (e.g. a packed varint array, which
 *      can coincidentally be valid UTF-8).
 * Returns '' for a zero-length field (vacuously printable, not rejected) and
 * null for anything else that doesn't clear both checks, or isn't a
 * wireType-2 field at all.
 */
export function asText(
  field: ParsedField | undefined,
  minPrintableRatio: number = DEFAULT_MIN_PRINTABLE_RATIO,
): string | null {
  if (!field || field.wireType !== 2 || !field.raw) return null
  if (field.raw.length === 0) return ''

  const text = field.raw.toString('utf8')
  if (Buffer.byteLength(text, 'utf8') !== field.raw.length) return null

  let printable = 0
  let total = 0
  for (const ch of text) {
    total++
    if (isPrintableCodePoint(ch.codePointAt(0) ?? 0)) printable++
  }
  if (total === 0) return ''
  return printable / total >= minPrintableRatio ? text : null
}

/** A wireType-0 field's value as a `number`, or null when the field is
 *  missing/wrong-wireType or the value exceeds Number.MAX_SAFE_INTEGER
 *  (returning an imprecise number would be worse than returning null). */
export function asVarintNumber(field: ParsedField | undefined): number | null {
  if (!field || field.wireType !== 0 || field.varint === undefined) return null
  if (field.varint > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(field.varint)
}
