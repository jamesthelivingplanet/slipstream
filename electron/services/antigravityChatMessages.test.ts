import { describe, it, expect } from 'vitest'
import {
  mapAntigravityStep,
  parseAntigravitySteps,
  isPlausibleToolName,
  isPlausibleJsonArgs,
  type AntigravityStepRow,
} from './antigravityChatMessages.js'

// Hand-built protobuf wire-format encoders, independent of protoWalk.ts's
// own implementation (same approach as protoWalk.test.ts) — these build the
// byte-level fixtures this mapper is tested against.

function encodeVarint(n: bigint | number): Buffer {
  let v = typeof n === 'bigint' ? n : BigInt(n)
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

function msg(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts)
}

const CONV = 'conv-abc'

describe('mapAntigravityStep — step_type 14 (user message)', () => {
  it('extracts user text from .19.2', () => {
    const payload = msg(lenField(19, textField(2, 'hello agent')))
    const row: AntigravityStepRow = { idx: 0, step_type: 14, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out).toEqual({
      uuid: `${CONV}:0`,
      role: 'user',
      blocks: [{ type: 'text', text: 'hello agent' }],
      ts: 0, // no plausible timestamp in .5 (absent) — falls back to idx
    })
  })

  it('falls back to .19.3.1 when .19.2 is absent', () => {
    const nested = lenField(3, textField(1, 'nested user text'))
    const payload = msg(lenField(19, nested))
    const row: AntigravityStepRow = { idx: 1, step_type: 14, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks).toEqual([{ type: 'text', text: 'nested user text' }])
  })

  it('returns null when neither .19.2 nor .19.3.1 decode to text (non-printable blob)', () => {
    const garbage = Buffer.from([0x80, 0x81, 0xff, 0xfe, 0x00, 0x01, 0x02])
    const payload = msg(lenField(19, lenField(2, garbage)))
    const row: AntigravityStepRow = { idx: 0, step_type: 14, step_payload: payload }
    expect(mapAntigravityStep(row, CONV)).toBeNull()
  })

  it('handles a second type-14 step (unverified follow-up shape) the same as the first', () => {
    const payload = msg(lenField(19, textField(2, 'follow-up message')))
    const row: AntigravityStepRow = { idx: 5, step_type: 14, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'follow-up message' }],
    })
  })
})

describe('mapAntigravityStep — step_type 15 (assistant narration + tool call)', () => {
  it('extracts narration text only when no tool call is present', () => {
    const payload = msg(lenField(20, textField(1, 'thinking about it')))
    const row: AntigravityStepRow = { idx: 2, step_type: 15, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out).toEqual({
      uuid: `${CONV}:2`,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'thinking about it' }],
      ts: 2,
    })
  })

  it('emits ONLY the narration text block, even when .20.7 carries a full realistic echoed call (DEFECT 1 fix)', () => {
    // Real field layout: 1=id, 2=name, 3=json args, 9=name-dup. Before the
    // fix, this would have produced a tool_use block too — but step_type=15
    // never emits tool_use now, because the following tool-executing row is
    // always the authoritative source for that call (FINDING B).
    const echoedCall = msg(
      textField(1, 'oh3ss4n6'), // opaque call id — must never leak into output
      textField(2, 'view_file'),
      textField(3, '{"path":"a.ts"}'),
      textField(9, 'view_file'),
    )
    const payload = msg(lenField(20, msg(textField(1, 'reading file'), lenField(7, echoedCall))))
    const row: AntigravityStepRow = { idx: 3, step_type: 15, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks).toEqual([{ type: 'text', text: 'reading file' }])
  })

  it('returns null when there is neither narration nor a recognizable tool call', () => {
    const payload = msg(lenField(20, varintField(9, 1)))
    const row: AntigravityStepRow = { idx: 0, step_type: 15, step_payload: payload }
    expect(mapAntigravityStep(row, CONV)).toBeNull()
  })
})

describe('mapAntigravityStep — tool steps (7/8/9/21/5/132)', () => {
  it('grep_search (7): uses the fixed fallback tool name and dumps printable text from .13', () => {
    const payload = msg(
      lenField(13, msg(textField(1, 'match: foo.ts:12'), textField(2, 'src/foo.ts'))),
    )
    const row: AntigravityStepRow = { idx: 0, step_type: 7, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    const toolUseId = `${CONV}:0:tool_use`
    expect(out).toEqual({
      uuid: `${CONV}:0`,
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: toolUseId, name: 'grep_search', input: {} },
        { type: 'tool_result', toolUseId, content: 'match: foo.ts:12\nsrc/foo.ts' },
      ],
      ts: 0,
    })
  })

  it('prefers the echoed tool call at .5.4 over the step_type fallback name', () => {
    // Real field layout: 1=id, 2=name, 3=json args, 9=name-dup.
    const echoedCall = msg(
      textField(1, 'q78hkxyt'), // opaque call id — must NOT end up as the name
      textField(2, 'grep_search'),
      textField(3, '{"pattern":"TODO"}'),
      textField(9, 'grep_search'),
    )
    const envelope = lenField(4, echoedCall)
    const payload = msg(lenField(5, envelope), lenField(13, textField(1, 'a match')))
    const row: AntigravityStepRow = { idx: 1, step_type: 7, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks[0]).toEqual({
      type: 'tool_use',
      id: `${CONV}:1:tool_use`,
      name: 'grep_search',
      input: { pattern: 'TODO' },
    })
  })

  it('DEFECT 2 regression: a single tool-executing step never yields the opaque id as the tool_use name', () => {
    // field 1 = id (no underscore, id-shaped), field 2 = name, field 3 =
    // args, field 9 = name-dup — real wire order (id before name).
    const echoedCall = msg(
      textField(1, 'oh3ss4n6'),
      textField(2, 'list_permissions'),
      textField(3, '{"toolAction":"Listing current permissions"}'),
      textField(9, 'list_permissions'),
    )
    const envelope = lenField(4, echoedCall)
    const payload = msg(lenField(5, envelope), lenField(140, textField(2, 'fs:read')))
    const row: AntigravityStepRow = { idx: 0, step_type: 132, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    const toolUse = out?.blocks[0] as { name: string }
    expect(toolUse.name).toBe('list_permissions')
    expect(toolUse.name).not.toBe('oh3ss4n6')
  })

  it('DEFECT 2 regression: manage_task (step_type 132 is NOT exclusively list_permissions)', () => {
    const echoedCall = msg(
      textField(1, 'ctiy4yvd'),
      textField(2, 'manage_task'),
      textField(3, '{"Action":"send_input","Input":"a\\n"}'),
      textField(9, 'manage_task'),
    )
    const envelope = lenField(4, echoedCall)
    const payload = msg(lenField(5, envelope), lenField(140, textField(2, 'task status')))
    const row: AntigravityStepRow = { idx: 0, step_type: 132, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    const toolUse = out?.blocks[0] as { name: string; input: unknown }
    expect(toolUse.name).toBe('manage_task')
    expect(toolUse.input).toEqual({ Action: 'send_input', Input: 'a\n' })
  })

  it('run_command (21): dumps printable content and falls back to its fixed tool name', () => {
    const payload = msg(lenField(28, msg(textField(1, '/repo'), textField(3, 'echo hi'))))
    const row: AntigravityStepRow = { idx: 0, step_type: 21, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks[0]).toMatchObject({ name: 'run_command' })
    expect(out?.blocks[1]).toMatchObject({ content: '/repo\necho hi' })
  })

  it('list_permissions (132): reads .140.2 directly when present', () => {
    const payload = msg(lenField(140, msg(varintField(1, 1), textField(2, 'fs:read, fs:write'))))
    const row: AntigravityStepRow = { idx: 0, step_type: 132, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks[1]).toMatchObject({ content: 'fs:read, fs:write' })
  })

  it('list_permissions (132): falls back to a subtree dump when .140.2 is absent', () => {
    const payload = msg(lenField(140, msg(textField(9, 'read-only workspace access'))))
    const row: AntigravityStepRow = { idx: 0, step_type: 132, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks[1]).toMatchObject({ content: 'read-only workspace access' })
  })

  it('emits empty content (not a guess) when the payload field has no recoverable text', () => {
    const payload = msg(lenField(14, varintField(1, 999)))
    const row: AntigravityStepRow = { idx: 0, step_type: 8, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks[1]).toMatchObject({ content: '' })
  })
})

describe('mapAntigravityStep — step_type 17 (error)', () => {
  it('extracts error text from .24.3 as a clearly-marked assistant text block', () => {
    const payload = msg(lenField(24, msg(varintField(1, 500), textField(3, 'rate limited'))))
    const row: AntigravityStepRow = { idx: 0, step_type: 17, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out).toEqual({
      uuid: `${CONV}:0`,
      role: 'assistant',
      blocks: [{ type: 'text', text: '[antigravity error] rate limited' }],
      ts: 0,
    })
  })

  it('falls back to a subtree dump of .24 when .24.3 is absent', () => {
    const payload = msg(lenField(24, textField(9, 'connection reset')))
    const row: AntigravityStepRow = { idx: 0, step_type: 17, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks).toEqual([{ type: 'text', text: '[antigravity error] connection reset' }])
  })

  it('returns null when nothing recoverable exists under .24', () => {
    const payload = msg(lenField(24, varintField(1, 1)))
    const row: AntigravityStepRow = { idx: 0, step_type: 17, step_payload: payload }
    expect(mapAntigravityStep(row, CONV)).toBeNull()
  })
})

describe('mapAntigravityStep — unrecognized step_type (drift guard)', () => {
  it('emits a clearly-labelled raw dump, never guessed prose, for an unrecognized step_type', () => {
    const payload = msg(varintField(1, 42), textField(2, 'some field'))
    const row: AntigravityStepRow = { idx: 7, step_type: 999, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.role).toBe('assistant')
    expect(out?.blocks[0]).toMatchObject({ type: 'tool_use', name: 'antigravity:unknown-step-999' })
    expect(out?.blocks[1]).toMatchObject({ type: 'tool_result', isError: true })
    expect((out?.blocks[1] as { content: string }).content).toContain('unrecognized step_type 999')
    expect((out?.blocks[1] as { content: string }).content).not.toContain('some field') // no guessed prose
  })

  it('applies the same unrecognized-step raw dump to seen-but-uncharacterized step_types (98/101/23)', () => {
    const payload = msg(lenField(111, textField(1, 'whatever this is')))
    const row: AntigravityStepRow = { idx: 0, step_type: 98, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.blocks[0]).toMatchObject({ name: 'antigravity:unknown-step-98' })
  })

  it('returns null for an unrecognized step_type whose payload is empty', () => {
    const row: AntigravityStepRow = { idx: 0, step_type: 999, step_payload: Buffer.alloc(0) }
    expect(mapAntigravityStep(row, CONV)).toBeNull()
  })
})

describe('mapAntigravityStep — malformed/missing payload', () => {
  it('returns null for a null step_payload', () => {
    const row: AntigravityStepRow = { idx: 0, step_type: 14, step_payload: null }
    expect(mapAntigravityStep(row, CONV)).toBeNull()
  })

  it('never throws on a truncated/malformed step_payload buffer', () => {
    const truncated = Buffer.from([0x9a, 0x01, 0xff, 0x02, 0x80]) // garbage, mid-varint truncation
    const row: AntigravityStepRow = { idx: 0, step_type: 14, step_payload: truncated }
    expect(() => mapAntigravityStep(row, CONV)).not.toThrow()
  })

  it('never throws on a step_payload that is valid protobuf but the wrong shape entirely', () => {
    const payload = msg(varintField(1, 1), varintField(2, 2), varintField(3, 3))
    const row: AntigravityStepRow = { idx: 0, step_type: 7, step_payload: payload }
    expect(() => mapAntigravityStep(row, CONV)).not.toThrow()
  })
})

describe('mapAntigravityStep — timestamp resolution', () => {
  it('recovers a plausible epoch-ms timestamp from the .5 envelope', () => {
    const epochMs = Date.UTC(2026, 6, 20, 12, 0, 0)
    const envelope = lenField(5, varintField(2, epochMs))
    const payload = msg(envelope, lenField(19, textField(2, 'hi')))
    const row: AntigravityStepRow = { idx: 0, step_type: 14, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.ts).toBe(epochMs)
  })

  it('recovers a plausible epoch-SECONDS timestamp from the .5 envelope, converting to ms', () => {
    const epochSeconds = Math.floor(Date.UTC(2026, 6, 20, 12, 0, 0) / 1000)
    const envelope = lenField(5, varintField(2, epochSeconds))
    const payload = msg(envelope, lenField(19, textField(2, 'hi')))
    const row: AntigravityStepRow = { idx: 0, step_type: 14, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.ts).toBe(epochSeconds * 1000)
  })

  it('falls back to idx (never NaN) when no plausible timestamp is found', () => {
    const envelope = lenField(5, varintField(2, 7)) // not in any plausible timestamp range
    const payload = msg(envelope, lenField(19, textField(2, 'hi')))
    const row: AntigravityStepRow = { idx: 42, step_type: 14, step_payload: payload }
    const out = mapAntigravityStep(row, CONV)
    expect(out?.ts).toBe(42)
    expect(Number.isFinite(out?.ts)).toBe(true)
  })
})

describe('parseAntigravitySteps', () => {
  it('preserves input row order and skips unrecoverable rows', () => {
    const rows: AntigravityStepRow[] = [
      { idx: 0, step_type: 14, step_payload: msg(lenField(19, textField(2, 'go'))) },
      { idx: 1, step_type: 14, step_payload: null }, // skipped
      { idx: 2, step_type: 15, step_payload: msg(lenField(20, textField(1, 'done'))) },
    ]
    const out = parseAntigravitySteps(rows, CONV)
    expect(out.map((m) => m.uuid)).toEqual([`${CONV}:0`, `${CONV}:2`])
  })

  it('produces stable, unique uuids of the form conversationId:idx', () => {
    const rows: AntigravityStepRow[] = [
      { idx: 3, step_type: 14, step_payload: msg(lenField(19, textField(2, 'x'))) },
    ]
    expect(parseAntigravitySteps(rows, 'my-conv')[0].uuid).toBe('my-conv:3')
  })

  it('DEFECT 1 regression: a step_type=15 narration preview + its following tool-executing row produce exactly ONE tool_use, paired with exactly one tool_result', () => {
    // Real-world shape: row N is step_type=15 narration whose .20.7 previews
    // an upcoming run_command call; row N+1 is the actual step_type=21
    // execution row whose .5.4 echoes the SAME call (id/name/args/name-dup)
    // and carries the real result at .28.
    const echoedCall = msg(
      textField(1, 'ctiy4yvd'), // opaque id — same on both rows
      textField(2, 'run_command'),
      textField(3, '{"CommandLine":"pwd && ls -la"}'),
      textField(9, 'run_command'),
    )
    const narrationPayload = msg(
      lenField(20, msg(textField(1, 'about to run a command'), lenField(7, echoedCall))),
    )
    const executionPayload = msg(
      lenField(5, lenField(4, echoedCall)),
      lenField(28, textField(3, 'total 0\ndrwxr-xr-x')),
    )
    const rows: AntigravityStepRow[] = [
      { idx: 10, step_type: 15, step_payload: narrationPayload },
      { idx: 11, step_type: 21, step_payload: executionPayload },
    ]
    const out = parseAntigravitySteps(rows, CONV)

    const toolUses = out.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use'))
    const toolResults = out.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_result'))
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0]).toMatchObject({ name: 'run_command' })
    expect(toolResults).toHaveLength(1)
    expect((toolResults[0] as { toolUseId: string }).toolUseId).toBe(
      (toolUses[0] as { id: string }).id,
    )

    // The narration row still renders its own text.
    expect(out[0].blocks).toEqual([{ type: 'text', text: 'about to run a command' }])
  })
})

describe('isPlausibleToolName', () => {
  it.each([
    'grep_search',
    'view_file',
    'list_dir',
    'run_command',
    'write_to_file',
    'list_permissions',
    'edit_file',
  ])('accepts %s', (name) => {
    expect(isPlausibleToolName(name)).toBe(true)
  })

  it.each([
    'This is a narration sentence.',
    'Reading the file now...',
    '',
    'UPPERCASE_NAME',
    'has spaces here',
    'a'.repeat(50),
    // Opaque tool-call ids (DEFECT 2 regression) — no underscore, so the
    // tightened regex must reject them even though they're plain lowercase
    // alphanumeric and within the length bounds.
    'oh3ss4n6',
    'ctiy4yvd',
    'lelayhod',
  ])('rejects %s', (text) => {
    expect(isPlausibleToolName(text)).toBe(false)
  })
})

describe('isPlausibleJsonArgs', () => {
  it('accepts a JSON object', () => {
    expect(isPlausibleJsonArgs('{"path":"a.ts"}')).toBe(true)
  })

  it('accepts a JSON array', () => {
    expect(isPlausibleJsonArgs('[1,2,3]')).toBe(true)
  })

  it('rejects prose', () => {
    expect(isPlausibleJsonArgs('this is not json at all')).toBe(false)
  })

  it('rejects malformed JSON that merely looks bracketed', () => {
    expect(isPlausibleJsonArgs('{not: valid json}')).toBe(false)
  })
})
