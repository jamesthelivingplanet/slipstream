/**
 * antigravityChatMessages — REVERSE-ENGINEERED, BEST-EFFORT pure mapper for
 * antigravity's (`agy`) per-conversation SQLite chat history (TASK-N6X4R),
 * in the style of the sibling mappers transcriptMessages.ts (claude-code),
 * piChatMessages.ts (pi), and grokChatMessages.ts (grok): dependency-free
 * and lenient. This module walks `steps.step_payload` — raw protobuf WIRE
 * FORMAT bytes, via protoWalk.ts — and maps them to
 * `SessionChatMessageDTO[]`.
 *
 * ============================ HONEST FRAMING ============================
 * There is NO `.proto` schema for antigravity practically obtainable (the
 * `agy` binary is a stripped ~187MB Go ELF; struct-tag field *names*
 * survive but the enum name→number mapping for CORTEX_STEP_TYPE_* could
 * not be recovered). Everything below is reverse-engineered from TWO real
 * conversation databases and is best-effort by construction, not
 * authoritative. A schema-less protobuf walk NEVER errors on its own — fed
 * bytes from a changed `agy` build, it will happily mislabel fields and
 * produce confidently-wrong prose. Wrong content is worse than absent
 * content, so this module is built around one rule: when a step's shape
 * doesn't match what's documented below, emit NOTHING or a clearly-marked
 * raw dump — never guessed prose. See "DRIFT / RE-VERIFICATION" at the
 * bottom for how to re-check this mapping after an `agy` upgrade.
 * ==========================================================================
 *
 * EMPIRICALLY-VERIFIED MAPPING (`steps` table: idx, step_type, step_payload,
 * ...). `step_type` selects which SINGLE top-level protobuf field on
 * `step_payload` carries that step's payload — there is NO arithmetic
 * relationship between step_type and field number, so this MUST stay a
 * hardcoded table (STEP_TYPE_FIELD below). Field `.5` is a shared metadata
 * envelope present alongside the payload field (timestamps, ids); for tool
 * steps `.5.4` echoes the tool call.
 *
 *   step_type | meaning                          | payload field | content
 *   14        | trajectory start — user message  | .19            | .19.2 / .19.3.1 = user text
 *   15        | assistant narration (+ upcoming-call preview) | .20 | .20.1 = narration; .20.7 previews the NEXT row's tool call but is intentionally NOT rendered here (see DEFECT 1 / FINDING B below)
 *   7         | grep_search call+result           | .13            | match text, file path, pattern
 *   8         | view_file call+result             | .14            | file URI, line range, file content
 *   9         | list_dir call+result               | .15            | directory listing
 *   21        | run_command call+result           | .28            | cwd, command line, stdout
 *   5         | write_to_file                      | .10            | generated document text + file URI
 *   17        | error message                      | .24.3          | error text, HTTP status, retry info
 *   132       | list_permissions OR manage_task result | .140.2     | permission grant list / task-management payload (see STEP_TYPE_TOOL_NAME's 132 comment — step_type alone does not determine the tool)
 *   98/101/23 | seen, uncharacterized              | .111/.114/.30  | unknown
 *
 * This covers ~10 of ~140 known CORTEX_STEP_TYPE_* values — everything else
 * is UNRECOGNIZED and goes through the raw-dump path (see below). A
 * mid-conversation FOLLOW-UP user message (a second step_type=14) was never
 * observed in either sample (both were single-shot, one step_type=14 at
 * idx 0) — this mapper treats every step_type=14 identically regardless of
 * idx, so a second one is handled the same way a first is, but that shape
 * is genuinely unverified.
 *
 * RECOVERED SUB-STRUCTURE — the echoed-call envelope (`.5.4` on every
 * tool-executing step; `.20.7` on the preceding step_type=15 narration
 * step): confirmed across ~140 real tool-call instances in TWO real
 * conversation databases (TASK-N6X4R), this submessage has a fixed field
 * layout:
 *   field 1 = the tool call's opaque id — an 8-char lowercase alphanumeric
 *             token (e.g. "oh3ss4n6"), NEVER a tool name, NEVER contains an
 *             underscore in any observed sample.
 *   field 2 = the tool name (e.g. "run_command", "view_file", "manage_task").
 *   field 3 = a JSON object of call args.
 *   field 9 = the tool name again, byte-identical duplicate of field 2.
 * extractToolCallFromField uses fields 2/9 (name) and 3 (args) as the
 * PRIMARY path now that this layout is confirmed reliable, with a defensive
 * generic subtree walk (explicitly skipping field 1 — see below) as a
 * fallback for drift resilience, keeping this module's "never trust a
 * single fixed number as the ONLY path" posture without re-treating the
 * layout as fully unknown.
 *   - Field 1 (the id) is intentionally NEVER read as a name, and is
 *     excluded from the fallback walk too — reading it as a name was
 *     exactly DEFECT 2 (a tool call rendering with its opaque id as the
 *     displayed name instead of e.g. "list_permissions"). Separately, a
 *     ChatBlock's tool_use.id only needs to be locally unique for
 *     tool_use/tool_result pairing within one DTO, so this mapper always
 *     synthesizes it from the step's own uuid rather than trusting any wire
 *     field for it — one fewer unverified assumption either way.
 *   - DEFECT 1 (every tool call rendered twice) turned out to be duplication
 *     ACROSS TWO ADJACENT `steps` ROWS, not within one row's fields: row N
 *     (step_type=15) echoes an upcoming call preview at `.20.7`, and row
 *     N+1 (the very next row, no exceptions observed in ~140 samples across
 *     both DBs) is the actual tool-executing step whose `.5.4` echoes the
 *     SAME call and carries the real result. The fix is for step_type=15 to
 *     never emit a tool_use block at all — see the stepType===15 branch in
 *     mapAntigravityStep for the details; the authoritative tool_use always
 *     comes from the following execution row.
 *   - Fields 7/8/9/21/5's CONTENT sub-structure (e.g. grep_search's "match
 *     text, file path, pattern") has no recovered per-field breakdown
 *     beyond the top-level field number — collectPrintableTexts walks that
 *     field's subtree and flattens every convincingly-printable text leaf
 *     (protoWalk.asText's ratio-threshold guard) into one blob, rather than
 *     naming individual pieces we have no verified layout for.
 */
import type { ChatBlock, SessionChatMessageDTO } from '../shared/contract.js'
import {
  walkMessage,
  subMessage,
  getPathFirst,
  firstField,
  asText,
  asVarintNumber,
  type WalkedMessage,
} from './protoWalk.js'

/** One row of antigravity's `steps` table, narrowed to the columns this
 *  mapper needs. `idx` is the ordering key (caller/store reads ordered by
 *  idx ASC); `step_type` selects the payload field; `step_payload` is the
 *  raw protobuf bytes (null/empty rows map to nothing). */
export interface AntigravityStepRow {
  idx: number
  step_type: number
  step_payload: Buffer | null
}

/** step_type -> the top-level protobuf field number on step_payload that
 *  carries that step's payload, per the recovered table above. NOT
 *  arithmetic — must stay hardcoded. The 98/101/23 entries are steps we've
 *  *seen* and know the payload field for, but never recovered content out
 *  of; they stay outside RENDERABLE_STEP_TYPES and go through the
 *  unrecognized-step path, this table only sharpens that path's raw-dump
 *  field summary. */
const STEP_TYPE_FIELD: Readonly<Record<number, number>> = {
  14: 19,
  15: 20,
  7: 13,
  8: 14,
  9: 15,
  21: 28,
  5: 10,
  17: 24,
  132: 140,
  98: 111,
  101: 114,
  23: 30,
}

/** step_type -> the fixed tool name to use when the tool call couldn't be
 *  (or wasn't) recovered from the `.5.4` echoed-call envelope — we already
 *  know semantically what these step_types ARE from the recovered table,
 *  independent of anything on the wire. */
const STEP_TYPE_TOOL_NAME: Readonly<Record<number, string>> = {
  7: 'grep_search',
  8: 'view_file',
  9: 'list_dir',
  21: 'run_command',
  5: 'write_to_file',
  // NOT exclusively list_permissions: confirmed empirically (real idx=125
  // step_type=15 -> idx=126 step_type=132) that step_type 132 is also used
  // for "manage_task" calls. step_type alone does not determine the tool
  // identity here — this is a last-resort fallback used only when the
  // `.5.4` echoed-call extraction fails entirely; resolveToolIdentity
  // already tries `.5.4` first, which is the reliable source.
  132: 'list_permissions',
}

const KNOWN_TOOL_NAMES = new Set(Object.values(STEP_TYPE_TOOL_NAME))

/**
 * Sanity check: does `text` look like a plausible tool identifier (as
 * opposed to narration prose, a file path, or random binary that happened
 * to decode as printable)? Exported so drift-detection tests — and anyone
 * debugging a mis-mapped `agy` build — can probe this independently of the
 * walker. Deliberately conservative: lowercase snake_case, 3-40 chars, no
 * spaces/punctuation beyond underscore. A real tool name we haven't seen
 * yet (this table only lists 6) still passes as long as it fits that
 * shape; prose narration essentially never does.
 *
 * The general (non-whitelisted) case REQUIRES at least one underscore
 * segment (`(_[a-z0-9]+)+`, not `*`) — every real tool name observed across
 * ~140 samples (run_command, view_file, grep_search, list_dir,
 * write_to_file, list_permissions, manage_task) is multi-word snake_case
 * with an underscore, while every opaque tool-call id observed in the same
 * samples (e.g. "oh3ss4n6", "ctiy4yvd", "lelayhod") has NO underscore. This
 * is what makes the check actually discriminate an id from a name — a bare
 * alphanumeric token used to pass here too, which is exactly what let a
 * call id win over the real tool name (DEFECT 2, TASK-N6X4R).
 */
export function isPlausibleToolName(text: string): boolean {
  if (KNOWN_TOOL_NAMES.has(text)) return true
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(text) && text.length >= 3 && text.length <= 40
}

/**
 * Sanity check: does `text` look like plausible JSON tool-call arguments?
 * Exported for the same drift-detection reason as isPlausibleToolName.
 * Requires balanced outer braces/brackets AND that it actually parses —
 * narration text essentially never satisfies both.
 */
export function isPlausibleJsonArgs(text: string): boolean {
  const trimmed = text.trim()
  const looksLikeObject = trimmed.startsWith('{') && trimmed.endsWith('}')
  const looksLikeArray = trimmed.startsWith('[') && trimmed.endsWith(']')
  if (!looksLikeObject && !looksLikeArray) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

interface ToolCallInfo {
  name: string
  input: unknown
}

/** Field numbers within the echoed-call envelope (`.5.4` on tool-executing
 *  steps, `.20.7` on the preceding narration step) — recovered empirically
 *  from ~140 real tool-call instances across two real conversation
 *  databases (TASK-N6X4R). Field 1 is always the call's opaque 8-char
 *  lowercase alphanumeric id and is intentionally never read as a name
 *  here: this mapper synthesizes its own tool_use id from the step's own
 *  uuid rather than trusting any wire field for it, consistent with the
 *  id-synthesis design note in the module doc above. */
const CALL_ID_FIELD = 1
const CALL_NAME_FIELD = 2
const CALL_ARGS_FIELD = 3
const CALL_NAME_FIELD_FALLBACK = 9

/** Defensive fallback for extractToolCallFromField: walk every field in the
 *  submessage looking for one that passes `predicate`, explicitly skipping
 *  CALL_ID_FIELD (field 1 is always the opaque id, never a name, and never
 *  parses as JSON either — skipped from the args walk too for clarity). */
function genericWalkFor(sub: WalkedMessage, predicate: (text: string) => boolean): string | null {
  for (const field of sub.fields) {
    if (field.fieldNumber === CALL_ID_FIELD) continue
    const text = asText(field)
    if (text !== null && predicate(text)) return text
  }
  return null
}

/** Extract a {tool name, JSON args} pair from the echoed-call envelope at
 *  `top`'s dotted `path` (`[5, 4]` or `[20, 7]`). Now that the envelope's
 *  field layout is empirically confirmed (see the CALL_*_FIELD constants
 *  above), fields 2/9 (name) and 3 (args) are tried FIRST as the preferred,
 *  reliable path; a generic subtree walk (skipping field 1) is the fallback
 *  for drift resilience, not the primary source anymore. Returns null when
 *  no name could be recovered by either path — never a guessed name. */
function extractToolCallFromField(top: WalkedMessage, path: number[]): ToolCallInfo | null {
  const sub = subMessage(getPathFirst(top, ...path))
  if (!sub) return null

  const primaryName = asText(firstField(sub, CALL_NAME_FIELD))
  const fallbackName = asText(firstField(sub, CALL_NAME_FIELD_FALLBACK))
  let name: string | null = null
  if (primaryName !== null && isPlausibleToolName(primaryName)) {
    name = primaryName
  } else if (fallbackName !== null && isPlausibleToolName(fallbackName)) {
    name = fallbackName
  } else {
    name = genericWalkFor(sub, isPlausibleToolName)
  }
  if (!name) return null

  const primaryArgs = asText(firstField(sub, CALL_ARGS_FIELD))
  const argsText =
    primaryArgs !== null && isPlausibleJsonArgs(primaryArgs)
      ? primaryArgs
      : genericWalkFor(sub, isPlausibleJsonArgs)

  let input: unknown = {}
  if (argsText) {
    try {
      input = JSON.parse(argsText)
    } catch {
      // isPlausibleJsonArgs already confirmed this parses; unreachable in
      // practice, but keep input at {} rather than throw if it somehow isn't.
    }
  }
  return { name, input }
}

/** Prefer the tool identity echoed in the shared envelope (`.5.4`) when it
 *  yields a plausible name; otherwise fall back to the step_type's known
 *  semantic tool name (we know what step_type 7 IS regardless of what's on
 *  the wire). Always returns something usable — a tool step always gets a
 *  tool_use block, per the mapping rules. */
function resolveToolIdentity(top: WalkedMessage, stepType: number): ToolCallInfo {
  const echoed = extractToolCallFromField(top, [5, 4])
  if (echoed) return echoed
  return { name: STEP_TYPE_TOOL_NAME[stepType] ?? `antigravity:step-${stepType}`, input: {} }
}

const MAX_DUMP_DEPTH = 6

/** Flatten every convincingly-printable text leaf out of a submessage's
 *  subtree, depth-first — the fallback content extraction for tool steps
 *  whose internal field layout was never recovered (only the top-level
 *  field number is known; see module doc). A field that decodes as text
 *  (protoWalk.asText's ratio-threshold guard) is taken as a leaf and NOT
 *  also recursed into as a submessage (avoids double-counting); a field
 *  that doesn't decode as text is tried as a submessage instead. Depth-
 *  capped defensively — protobuf bytes can't actually be cyclic, but
 *  adversarial/corrupt input walked as a submessage could still nest
 *  deeply. */
function collectPrintableTexts(msg: WalkedMessage | null, depth = 0): string[] {
  if (!msg || depth > MAX_DUMP_DEPTH) return []
  const out: string[] = []
  for (const field of msg.fields) {
    if (field.wireType !== 2) continue
    const text = asText(field)
    if (text !== null) {
      if (text.length > 0) out.push(text)
      continue
    }
    const nested = subMessage(field)
    if (nested && nested.fields.length > 0) out.push(...collectPrintableTexts(nested, depth + 1))
  }
  return out
}

function dumpField(top: WalkedMessage, fieldNumber: number): string {
  return collectPrintableTexts(subMessage(getPathFirst(top, fieldNumber))).join('\n')
}

function extractUserText(top: WalkedMessage): string | null {
  const direct = asText(getPathFirst(top, 19, 2))
  if (direct && direct.length > 0) return direct
  const nested = asText(getPathFirst(top, 19, 3, 1))
  if (nested && nested.length > 0) return nested
  return null
}

function extractNarration(top: WalkedMessage): string | null {
  const text = asText(getPathFirst(top, 20, 1))
  return text && text.length > 0 ? text : null
}

function extractErrorText(top: WalkedMessage): string | null {
  const direct = asText(getPathFirst(top, 24, 3))
  if (direct && direct.length > 0) return direct
  const dump = dumpField(top, 24)
  return dump.length > 0 ? dump : null
}

function extractPermissionsListing(top: WalkedMessage): string {
  const direct = asText(getPathFirst(top, 140, 2))
  if (direct && direct.length > 0) return direct
  return dumpField(top, 140)
}

/** Plausible-timestamp window used to recognize a varint in the `.5`
 *  envelope as a real epoch timestamp (seconds or milliseconds) rather
 *  than some other integer (a counter, a size, an enum). Deliberately wide
 *  (2015-2100) — this is a sanity bound, not a precise one. */
const TS_PLAUSIBLE_MIN_MS = Date.UTC(2015, 0, 1)
const TS_PLAUSIBLE_MAX_MS = Date.UTC(2100, 0, 1)

function plausibleTimestampMs(n: number): number | null {
  if (n >= TS_PLAUSIBLE_MIN_MS && n <= TS_PLAUSIBLE_MAX_MS) return n
  const asSeconds = n * 1000
  if (asSeconds >= TS_PLAUSIBLE_MIN_MS && asSeconds <= TS_PLAUSIBLE_MAX_MS) return asSeconds
  return null
}

/**
 * Derive `ts` from the `.5` shared envelope when a plausible epoch
 * timestamp can be found there (no specific field number for it was ever
 * recovered — every top-level varint field in `.5` is tried against a
 * sanity window). Falls back to `idx` itself (0, 1, 2, ...) when nothing
 * plausible is found: deterministic, never NaN, and strictly increasing
 * with conversation order, but NOT wall-clock time — a UI must not present
 * this fallback value as a real date. Documented here rather than silently
 * producing something that merely looks like a timestamp.
 */
function resolveTs(top: WalkedMessage, idx: number): number {
  const envelope = subMessage(getPathFirst(top, 5))
  if (envelope) {
    for (const field of envelope.fields) {
      const n = asVarintNumber(field)
      if (n === null) continue
      const ms = plausibleTimestampMs(n)
      if (ms !== null) return ms
    }
  }
  return idx
}

function stepUuid(conversationId: string, idx: number): string {
  return `${conversationId}:${idx}`
}

/** Structural (NOT content) summary of a message's top-level fields — field
 *  number, wire type, and byte length for length-delimited fields. Used
 *  ONLY by the unrecognized-step raw dump: this path exists precisely
 *  because the step's shape isn't understood, so attempting to decode
 *  "content" out of it here would be exactly the guessed-prose failure
 *  mode this module is built to avoid. */
function summarizeFields(top: WalkedMessage): string {
  if (top.fields.length === 0) return '(empty message)'
  return top.fields
    .map((f) => {
      if (f.wireType === 0) return `#${f.fieldNumber}:varint`
      if (f.wireType === 2) return `#${f.fieldNumber}:bytes(${f.raw?.length ?? 0})`
      if (f.wireType === 1) return `#${f.fieldNumber}:fixed64`
      return `#${f.fieldNumber}:fixed32`
    })
    .join(', ')
}

/** step_types this mapper knows how to render actual content for. Every
 *  other step_type (including 98/101/23, whose payload field is known but
 *  whose content never was) falls through to the unrecognized-step path. */
const RENDERABLE_STEP_TYPES = new Set([14, 15, 7, 8, 9, 21, 5, 17, 132])
const TOOL_STEP_TYPES = new Set([7, 8, 9, 21, 5, 132])

function mapUnrecognizedStep(
  top: WalkedMessage,
  stepType: number,
  uuid: string,
  ts: number,
): SessionChatMessageDTO | null {
  if (top.fields.length === 0) return null // truly nothing recoverable — emit nothing, not a dump
  const toolUseId = `${uuid}:tool_use`
  const blocks: ChatBlock[] = [
    { type: 'tool_use', id: toolUseId, name: `antigravity:unknown-step-${stepType}`, input: {} },
    {
      type: 'tool_result',
      toolUseId,
      content: `[antigravity: unrecognized step_type ${stepType} — mapping not verified for this build. Raw field summary: ${summarizeFields(top)}]`,
      isError: true,
    },
  ]
  return { uuid, role: 'assistant', blocks, ts }
}

/**
 * Map one `steps` row to a chat DTO, or null when nothing renderable could
 * be recovered from it. Never throws — a malformed/truncated
 * `step_payload` walks to a mostly-empty WalkedMessage (protoWalk.ts is
 * total) and simply yields fewer/no blocks here.
 */
export function mapAntigravityStep(
  row: AntigravityStepRow,
  conversationId: string,
): SessionChatMessageDTO | null {
  if (!row.step_payload || row.step_payload.length === 0) return null

  const top = walkMessage(row.step_payload)
  const uuid = stepUuid(conversationId, row.idx)
  const ts = resolveTs(top, row.idx)
  const stepType = row.step_type

  if (!RENDERABLE_STEP_TYPES.has(stepType)) {
    return mapUnrecognizedStep(top, stepType, uuid, ts)
  }

  if (stepType === 14) {
    const text = extractUserText(top)
    if (!text) return null
    return { uuid, role: 'user', blocks: [{ type: 'text', text }], ts }
  }

  if (stepType === 15) {
    // Narration ONLY — never a tool_use here. DEFECT 1 (every tool call
    // rendering twice) root-caused to this: `.20.7` on a step_type=15 row
    // echoes a PREVIEW of the upcoming tool call, and in every one of ~140
    // observed real instances across two conversation databases, the VERY
    // NEXT row is the actual tool-executing step whose `.5.4` echoes the
    // SAME call and carries the real result — that row is the authoritative
    // source for the call's tool_use+tool_result pair. Emitting a tool_use
    // from `.20.7` as well produced a second, dangling, unpaired tool_use
    // for the same call. Do not re-add an extractToolCallFromField(top,
    // [20, 7]) call here — see FINDING B / DEFECT 1 (TASK-N6X4R) and the
    // module doc's "RECOVERED SUB-STRUCTURE" section above.
    const narration = extractNarration(top)
    if (!narration) return null
    return { uuid, role: 'assistant', blocks: [{ type: 'text', text: narration }], ts }
  }

  if (stepType === 17) {
    const text = extractErrorText(top)
    if (!text) return null
    // A bare tool_result here would dangle with no matching tool_use in
    // this DTO (error steps aren't a call/result pair) — a plain, clearly-
    // marked assistant text block avoids implying a pairing that doesn't
    // exist, unlike the tool steps below which synthesize both halves
    // themselves.
    return {
      uuid,
      role: 'assistant',
      blocks: [{ type: 'text', text: `[antigravity error] ${text}` }],
      ts,
    }
  }

  if (TOOL_STEP_TYPES.has(stepType)) {
    const fieldNumber = STEP_TYPE_FIELD[stepType]
    const content = stepType === 132 ? extractPermissionsListing(top) : dumpField(top, fieldNumber)
    const identity = resolveToolIdentity(top, stepType)
    const toolUseId = `${uuid}:tool_use`
    const blocks: ChatBlock[] = [
      { type: 'tool_use', id: toolUseId, name: identity.name, input: identity.input },
      { type: 'tool_result', toolUseId, content },
    ]
    return { uuid, role: 'assistant', blocks, ts }
  }

  // Unreachable given RENDERABLE_STEP_TYPES's membership, but keep the
  // module total rather than assume the sets above can never drift apart.
  return mapUnrecognizedStep(top, stepType, uuid, ts)
}

/** Map a conversation's `steps` rows into chat DTOs. Rows are expected
 *  pre-sorted by `idx` ASC (antigravityStore.ts's query does this) — this
 *  function preserves input order rather than re-sorting, matching
 *  grokChatMessages.ts's convention. */
export function parseAntigravitySteps(
  rows: AntigravityStepRow[],
  conversationId: string,
): SessionChatMessageDTO[] {
  const messages: SessionChatMessageDTO[] = []
  for (const row of rows) {
    const msg = mapAntigravityStep(row, conversationId)
    if (msg) messages.push(msg)
  }
  return messages
}

/*
 * DRIFT / RE-VERIFICATION
 * ------------------------
 * After any `agy` upgrade, this mapping should be re-checked before trusting
 * it again:
 *   1. Find a real conversation db under `~/.gemini/antigravity-cli/
 *      conversations/<uuid>.db` and COPY it to a scratch directory — never
 *      open the user's real file directly while poking at this.
 *   2. `SELECT idx, step_type, length(step_payload) FROM steps ORDER BY
 *      idx` — check step_type values against STEP_TYPE_FIELD above; any
 *      value not in that table is already handled safely (unrecognized-step
 *      path), but a HIGH-FREQUENCY unknown step_type is worth investigating.
 *   3. For a row whose step_type IS in STEP_TYPE_FIELD, walk step_payload
 *      with protoWalk.walkMessage and manually inspect whether the expected
 *      field number still holds the expected kind of content (asText on
 *      the documented path should still produce recognizable text, not
 *      null/garbage). A silent shift here is exactly the "confidently
 *      wrong content" failure mode — if the expected field now decodes to
 *      nonsense, do NOT patch the field number based on one sample; find
 *      the same shape across at least two conversations before trusting it,
 *      the same way this table itself was built.
 *   4. isPlausibleToolName/isPlausibleJsonArgs are the two checkable guard
 *      functions gating the `.5.4` echoed-call extraction on TOOL-EXECUTING
 *      steps (7/8/9/21/5/132) — if a real tool name starts failing
 *      isPlausibleToolName (e.g. a build introduces camelCase or dotted
 *      names, or drops the underscore convention this check now requires),
 *      resolveToolIdentity quietly falls back to STEP_TYPE_TOOL_NAME
 *      instead of the real echoed name (never a wrong guess, but a
 *      staleness symptom worth checking for) rather than erroring. Note
 *      step_type=15 no longer extracts any tool call at all (see the
 *      stepType===15 branch and FINDING B / DEFECT 1, TASK-N6X4R) — that's
 *      by design, not something to "fix" if you notice it.
 */
