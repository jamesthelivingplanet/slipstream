/**
 * transcriptMessages — pure parser for the Claude Code transcript JSONL
 * (`~/.claude/projects/**\/<id>.jsonl`, resolved by `transcripts.ts`), in the
 * style of agentEventsSentinel.ts (TASK-FPH60): dependency-free (usable from
 * sessionManager's watcher without pulling in fs) and lenient — malformed or
 * partially-written trailing lines are skipped, not fatal. The watcher
 * re-reads only the file's tail on each fs event, so `createChatCursor`'s
 * uuid dedupe is what keeps a re-delivered line from producing a duplicate
 * chat message.
 *
 * Real transcripts stream one *content block* per line: a single assistant
 * turn's thinking/text/tool_use blocks each get their own line with a unique
 * `uuid`, chained via `parentUuid`. So `SessionChatMessageDTO.blocks` is
 * usually length 0 or 1 here — grouping/pairing blocks into a turn is a
 * renderer (Phase 2) concern, not this parser's.
 *
 * This parser also parses `isSidechain:true` lines (a Task-tool subagent
 * turn) and carries `isSidechain`/`parentUuid` through on the DTO, IF it is
 * ever fed one — but as a factual finding (not a TODO owned by this file):
 * every real sidechain line observed on this machine lives in a SEPARATE
 * file, `<sessionId>/subagents/agent-*.jsonl`, not inline in the main
 * `<sessionId>.jsonl` this parser is fed today. `transcripts.ts`'s
 * `transcriptPathFor` and its caller `sessionChatReader.ts` currently only
 * resolve/read the single main transcript file and never the sibling
 * `subagents/agent-*.jsonl` files, so today this parser will still never
 * actually receive a sidechain line in practice. Full end-to-end wiring
 * (discovering/watching the subagent files) is a separate change to those
 * two files.
 */
import type { ChatBlock, SessionChatMessageDTO } from '../shared/contract.js'

/** Convert one raw content-block object into zero or more ChatBlocks. Most
 *  kinds map to a single block; `tool_result` can additionally surface
 *  sibling `image` blocks pulled out of its `content` array (see
 *  `toolResultContentToParts`), so this returns an array. Returns `[]` for a
 *  kind the chat view doesn't render (an unrecognized/future block kind) or
 *  one missing a required field. Never throws. */
function blockFromRaw(raw: unknown): ChatBlock[] {
  if (typeof raw !== 'object' || raw === null) return []
  const b = raw as Record<string, unknown>

  switch (b['type']) {
    case 'text': {
      const text = b['text']
      return typeof text === 'string' ? [{ type: 'text', text }] : []
    }
    case 'thinking': {
      const thinking = b['thinking']
      return typeof thinking === 'string' ? [{ type: 'thinking', text: thinking }] : []
    }
    case 'image': {
      const img = imageBlockFromSource(b['source'])
      return img ? [img] : []
    }
    case 'tool_use': {
      const id = b['id']
      const name = b['name']
      if (typeof id !== 'string' || typeof name !== 'string') return []
      return [{ type: 'tool_use', id, name, input: b['input'] ?? {} }]
    }
    case 'tool_result': {
      const toolUseId = b['tool_use_id']
      if (typeof toolUseId !== 'string') return []
      const { text, images } = toolResultContentToParts(b['content'])
      const block: ChatBlock = { type: 'tool_result', toolUseId, content: text }
      if (b['is_error'] === true) block.isError = true
      return [block, ...images]
    }
    default:
      // Unrecognized/future block kind — not fatal, just not rendered.
      return []
  }
}

/** Build an `image` block from a content-block's `source` field, shared by
 *  the top-level `image` case and `toolResultContentToParts`'s content walk.
 *  Both confirmed real shapes use the same nested
 *  `{ source: { type:'base64', media_type, data } }` envelope. */
function imageBlockFromSource(raw: unknown): ChatBlock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  if (source['type'] !== 'base64') return null
  const data = source['data']
  if (typeof data !== 'string' || !data) return null
  const block: ChatBlock = { type: 'image', data }
  const mediaType = source['media_type']
  if (typeof mediaType === 'string') block.mediaType = mediaType
  return block
}

/** A tool_result's `content` is either a plain string or an array of
 *  content-part objects (text parts interleaved with e.g. images). Text
 *  parts flatten to `.text` (same join behavior as before); `image` parts
 *  become sibling `ChatBlock`s in `.images` instead of being silently
 *  dropped. */
function toolResultContentToParts(content: unknown): { text: string; images: ChatBlock[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }

  const textParts: string[] = []
  const images: ChatBlock[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part)
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    const p = part as Record<string, unknown>
    if (p['type'] === 'image') {
      const img = imageBlockFromSource(p['source'])
      if (img) images.push(img)
      continue
    }
    const text = p['text']
    if (typeof text === 'string') textParts.push(text)
  }
  return { text: textParts.filter((s) => s.length > 0).join('\n'), images }
}

/** A message's `content` is either a plain string (simple prompts/commands)
 *  or an array of content-block objects. */
function blocksFromContent(content: unknown): ChatBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const raw of content) blocks.push(...blockFromRaw(raw))
  return blocks
}

function parseLine(line: string): SessionChatMessageDTO | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const type = obj['type']
  if (type !== 'user' && type !== 'assistant') return null

  const uuid = obj['uuid']
  if (typeof uuid !== 'string' || !uuid) return null

  const timestamp = obj['timestamp']
  const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(ts)) return null

  const message = obj['message']
  if (typeof message !== 'object' || message === null) return null
  const msg = message as Record<string, unknown>

  const role = msg['role']
  if (role !== 'user' && role !== 'assistant') return null

  const blocks = blocksFromContent(msg['content'])
  if (blocks.length === 0) return null // e.g. a line whose only block was an unrecognized/future kind

  const dto: SessionChatMessageDTO = { uuid, role, blocks, ts }
  if (obj['isSidechain'] === true) dto.isSidechain = true
  const parentUuid = obj['parentUuid']
  if (typeof parentUuid === 'string' && parentUuid) dto.parentUuid = parentUuid
  return dto
}

/** Parse full (or tail) transcript JSONL content into chat messages, oldest
 *  first, skipping blank/malformed lines and lines with nothing renderable.
 *  Sidechain (subagent) lines are no longer categorically skipped — see the
 *  module doc comment for why this parser still won't see one in practice
 *  today. */
export function parseTranscriptMessages(raw: string): SessionChatMessageDTO[] {
  const messages: SessionChatMessageDTO[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseLine(trimmed)
    if (parsed) messages.push(parsed)
  }
  return messages
}

/**
 * Split raw tail-read text at the last newline: `complete` is safe to parse
 * (every line in it is fully written), `consumedBytes` is how many UTF-8
 * bytes of it were consumed — the watcher advances its byte-offset cursor by
 * exactly this much, so a trailing partial line (the transcript still being
 * written) is left for the next read instead of being silently dropped.
 * `consumedBytes` is 0 when there is no complete line yet.
 */
export function completeLines(text: string): { complete: string; consumedBytes: number } {
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { complete: '', consumedBytes: 0 }
  const complete = text.slice(0, lastNewline + 1)
  return { complete, consumedBytes: Buffer.byteLength(complete, 'utf8') }
}

/** The watcher's dedupe cursor: transcript timestamps can collide within a
 *  turn (same millisecond) and a re-read tail can re-include an already-seen
 *  line, so identity is by `uuid`, not `ts`/position. */
export interface ChatCursor {
  /** Parse `raw` (a `completeLines().complete` chunk, or a full read) and
   *  return only the messages not already delivered by this cursor. */
  next(raw: string): SessionChatMessageDTO[]
}

export function createChatCursor(): ChatCursor {
  const seen = new Set<string>()
  return {
    next(raw: string): SessionChatMessageDTO[] {
      const fresh: SessionChatMessageDTO[] = []
      for (const msg of parseTranscriptMessages(raw)) {
        if (seen.has(msg.uuid)) continue
        seen.add(msg.uuid)
        fresh.push(msg)
      }
      return fresh
    },
  }
}
