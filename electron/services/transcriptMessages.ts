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
 */
import type { ChatBlock, SessionChatMessageDTO } from '../shared/contract.js'

/** Convert one raw content-block object into a ChatBlock, or null when it's
 *  a kind the chat view doesn't render yet (thinking, image, ...) or is
 *  missing a required field. Never throws. */
function blockFromRaw(raw: unknown): ChatBlock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>

  switch (b['type']) {
    case 'text': {
      const text = b['text']
      return typeof text === 'string' ? { type: 'text', text } : null
    }
    case 'tool_use': {
      const id = b['id']
      const name = b['name']
      if (typeof id !== 'string' || typeof name !== 'string') return null
      return { type: 'tool_use', id, name, input: b['input'] ?? {} }
    }
    case 'tool_result': {
      const toolUseId = b['tool_use_id']
      if (typeof toolUseId !== 'string') return null
      const block: ChatBlock = {
        type: 'tool_result',
        toolUseId,
        content: toolResultContentToString(b['content']),
      }
      if (b['is_error'] === true) block.isError = true
      return block
    }
    default:
      // thinking / image / other future block kinds — not fatal, just not
      // rendered in chat (yet).
      return null
  }
}

/** A tool_result's `content` is either a plain string or an array of
 *  content-part objects (text parts interleaved with e.g. images); flatten
 *  to a single displayable string, dropping parts with no text. */
function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>)['text']
          if (typeof text === 'string') return text
        }
        return ''
      })
      .filter((s) => s.length > 0)
      .join('\n')
  }
  return ''
}

/** A message's `content` is either a plain string (simple prompts/commands)
 *  or an array of content-block objects. */
function blocksFromContent(content: unknown): ChatBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const raw of content) {
    const block = blockFromRaw(raw)
    if (block) blocks.push(block)
  }
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

  // Subagent (Task tool) chatter — rendered nowhere yet; skip (TASK-FPH60).
  if (obj['isSidechain'] === true) return null

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
  if (blocks.length === 0) return null // e.g. a thinking-only line — nothing to show

  return { uuid, role, blocks, ts }
}

/** Parse full (or tail) transcript JSONL content into chat messages, oldest
 *  first, skipping blank/malformed/sidechain lines and lines with nothing
 *  renderable. */
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
