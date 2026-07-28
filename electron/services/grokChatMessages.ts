/**
 * grokChatMessages — pure mapper for grok-dev's durable SQLite message store
 * (`~/.grok/grok.db`, read by grokStore.ts), in the style of the sibling
 * mappers transcriptMessages.ts (claude-code) and piChatMessages.ts (pi):
 * dependency-free and lenient — a malformed row or an unrecognized part kind
 * is skipped, not fatal.
 *
 * Unlike claude-code's transcript (one *content block* per JSONL line) or
 * pi's session file (one *message* per JSONL line, with tool results as
 * their own top-level entries), grok persists one row per `messages` table
 * entry where `message_json` is `JSON.stringify(message)` for a Vercel AI
 * SDK `ModelMessage` (ai@6) — the whole turn's content array in one row.
 * Verified against grok-dev v1.1.7's compiled source (dist/storage/
 * transcript.js: `insertMessage.run(sessionId, seq, message.role,
 * JSON.stringify(message), createdAt)`).
 *
 * `ModelMessage.role` is `'system' | 'user' | 'assistant' | 'tool'`, one more
 * than the DTO's `'user' | 'assistant'`. Mapped as:
 *   - `system`  → skipped entirely (not part of the visible conversation).
 *   - `user`    → DTO role 'user'.
 *   - `assistant` → DTO role 'assistant'.
 *   - `tool`    → DTO role 'user', carrying tool_result blocks. This mirrors
 *     claude-code's convention (tool_result rides inside a role:user
 *     message) and pi's synthetic-user mapping for its own toolResult
 *     entries — a tool result is conversationally "the user side" replying
 *     with the tool's output, and the DTO has no third role to give it.
 *
 * Content is `string | Part[]` for every role. Part kinds handled: `text`,
 * `tool-call`, `tool-result`, `reasoning` (→ `thinking` block), `image` and
 * an image-typed `file` (→ `image` block); the tool approval parts are
 * still skipped leniently.
 *
 * `reasoning`/`image`/`file` shapes below are taken from grok-dev's actual
 * installed `@ai-sdk/provider-utils` type defs — the same package version
 * this module already verified the envelope against — at
 * `node_modules/@ai-sdk/provider-utils/dist/index.d.ts` (`ReasoningPart`
 * ~line 681, `ImagePart` ~line 627, `FilePart` ~line 652, `DataContent`
 * ~line 598: `string | Uint8Array | ArrayBuffer | Buffer`). The local
 * `~/.grok/grok.db` `messages` table is empty on this machine (0 rows), so
 * this mapping is schema-verified against the installed SDK types, not
 * instance-verified against a captured row.
 */
import type { ChatBlock, SessionChatMessageDTO } from '../shared/contract.js'

/** One row of grok's `messages` table (`SELECT session_id, seq, role,
 *  message_json, created_at`). `role` is a redundant copy of the parsed
 *  `message_json`'s own `role` field (both written from the same
 *  `message.role` at insert time) — the mapper trusts the parsed JSON's
 *  `role`, since that's what actually determines the content shape. */
export interface GrokMessageRow {
  session_id: string
  seq: number
  role: string
  message_json: string
  created_at: string
}

function blockFromPart(raw: unknown): ChatBlock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>

  switch (p['type']) {
    case 'text': {
      const text = p['text']
      return typeof text === 'string' ? { type: 'text', text } : null
    }
    case 'tool-call': {
      const id = p['toolCallId']
      const name = p['toolName']
      if (typeof id !== 'string' || typeof name !== 'string') return null
      return { type: 'tool_use', id, name, input: p['input'] ?? {} }
    }
    case 'tool-result': {
      const toolUseId = p['toolCallId']
      if (typeof toolUseId !== 'string') return null
      const { content, isError } = toolResultOutputToString(p['output'])
      const block: ChatBlock = { type: 'tool_result', toolUseId, content }
      if (isError) block.isError = true
      return block
    }
    case 'reasoning': {
      const text = p['text']
      return typeof text === 'string' ? { type: 'thinking', text } : null
    }
    case 'image':
      return imageBlockFromAiSdkValue(p['image'], p['mediaType'])
    case 'file': {
      const mediaType = p['mediaType']
      if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) return null
      return imageBlockFromAiSdkValue(p['data'], mediaType)
    }
    default:
      // tool-approval-request / tool-approval-response — not rendered in
      // chat (yet); no visible content to show for these.
      return null
  }
}

/** AI SDK v6 image/file bytes are `DataContent | URL`
 *  (string | Uint8Array | ArrayBuffer | Buffer | URL) — grok's persisted
 *  message_json only round-trips the plain-string case cleanly through
 *  JSON.stringify/parse (a Buffer/Uint8Array serializes to a
 *  `{type:'Buffer',data:[...]}` object, not base64 bytes), so only a string
 *  value is handled here; anything else is skipped leniently. A
 *  `data:<mediaType>;base64,<data>` URI is unwrapped; a bare string is
 *  assumed to already be a base64 payload (the SDK's typical persisted
 *  form for an already-resolved message). */
function imageBlockFromAiSdkValue(rawValue: unknown, mediaTypeHint: unknown): ChatBlock | null {
  if (typeof rawValue !== 'string' || !rawValue) return null
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/.exec(rawValue)
  if (match) return { type: 'image', mediaType: match[1], data: match[2] }
  const block: ChatBlock = { type: 'image', data: rawValue }
  if (typeof mediaTypeHint === 'string') block.mediaType = mediaTypeHint
  return block
}

/** `ToolResultPart.output` is a discriminated union (ai@6's
 *  `ToolResultOutput`), not a plain string like claude-code's/pi's
 *  tool_result content — flatten each variant to a single displayable
 *  string, and surface the error variants as `isError:true`. */
function toolResultOutputToString(output: unknown): { content: string; isError: boolean } {
  if (typeof output !== 'object' || output === null) return { content: '', isError: false }
  const o = output as Record<string, unknown>

  switch (o['type']) {
    case 'text':
      return { content: typeof o['value'] === 'string' ? o['value'] : '', isError: false }
    case 'json':
      return { content: safeJsonStringify(o['value']), isError: false }
    case 'error-text':
      return { content: typeof o['value'] === 'string' ? o['value'] : '', isError: true }
    case 'error-json':
      return { content: safeJsonStringify(o['value']), isError: true }
    case 'execution-denied':
      // reason is optional per the SDK type; fall back to a sensible
      // constant so the chat view still shows *something* happened.
      return {
        content: typeof o['reason'] === 'string' ? o['reason'] : 'Execution denied',
        isError: true,
      }
    case 'content':
      return { content: toolResultContentPartsToString(o['value']), isError: false }
    default:
      // Unrecognized output variant (SDK adds one we don't know about yet).
      return { content: '', isError: false }
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** `output.value` for the `content` variant is an array of parts (text
 *  interleaved with e.g. media); flatten to text only, dropping the rest —
 *  mirrors `toolResultContentToString` in transcriptMessages.ts. */
function toolResultContentPartsToString(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>)['text']
        if (typeof text === 'string') return text
      }
      return ''
    })
    .filter((s) => s.length > 0)
    .join('\n')
}

/** A ModelMessage's `content` is either a plain string (simple prompts) or
 *  an array of part objects. */
function blocksFromContent(content: unknown): ChatBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const raw of content) {
    const block = blockFromPart(raw)
    if (block) blocks.push(block)
  }
  return blocks
}

/** Map one `messages` table row to a chat DTO, or null when the row is
 *  unusable (malformed JSON, unrecognized role, unparseable timestamp) or
 *  has nothing renderable (e.g. a turn with only a tool-approval part).
 *
 *  `ts` unparseable → the row is dropped rather than emitting NaN, same
 *  choice transcriptMessages.ts and piChatMessages.ts make: `ts` is a DTO
 *  contract field callers may sort/display by, so a bad value is worse than
 *  a missing message. Ordering itself doesn't depend on `ts` here — callers
 *  read rows already ordered by the table's monotonic `seq` — so dropping a
 *  message over a bad timestamp only affects display, not conversation
 *  order of the rest. */
export function mapGrokMessageRow(row: GrokMessageRow): SessionChatMessageDTO | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.message_json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const msg = parsed as Record<string, unknown>

  const role = msg['role']
  if (role === 'system') return null // system prompt — not part of the visible conversation
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null

  const blocks = blocksFromContent(msg['content'])
  if (blocks.length === 0) return null // e.g. a turn whose only part was a tool-approval part — nothing to show

  const ts = Date.parse(row.created_at)
  if (!Number.isFinite(ts)) return null

  return {
    uuid: `${row.session_id}:${row.seq}`,
    role: role === 'assistant' ? 'assistant' : 'user', // 'tool' rides as a synthetic user turn
    blocks,
    ts,
  }
}

/** Map a session's `messages` rows into chat DTOs. Rows are expected
 *  pre-sorted by `seq` ASC (grokStore.ts's query does this) — this function
 *  preserves input order rather than re-sorting, so it stays a pure
 *  row-shape mapper independent of how the caller fetched the rows. */
export function parseGrokMessages(rows: GrokMessageRow[]): SessionChatMessageDTO[] {
  const messages: SessionChatMessageDTO[] = []
  for (const row of rows) {
    const msg = mapGrokMessageRow(row)
    if (msg) messages.push(msg)
  }
  return messages
}
