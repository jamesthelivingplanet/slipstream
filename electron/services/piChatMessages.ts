/**
 * piChatMessages — pure parser for pi's JSONL session file (see
 * piSessions.ts for discovery/status parsing of the same file), mapping
 * entries to `SessionChatMessageDTO` for the chat view (TASK-FPH60 pi
 * extension). Dependency-free and lenient, in the style of
 * transcriptMessages.ts: malformed or partially-written trailing lines are
 * skipped, not fatal — the tail (chatTail.ts) re-reads only complete lines
 * anyway, so "partial" here really only means "not JSON we recognize".
 *
 * Format (https://pi.dev/docs/latest/session-format): each line is
 * `{ type: 'message', id, parentId, timestamp, message }`, where `message`
 * is one of:
 *   - UserMessage      { role: 'user', content: string | Block[] }
 *   - AssistantMessage { role: 'assistant', content: Block[], ... }
 *   - ToolResultMessage{ role: 'toolResult', toolCallId, toolName, content, isError }
 * Content blocks: `{ type: 'text', text }` and `{ type: 'toolCall', id, name,
 * arguments }` (assistant only); `thinking` and other block kinds are skipped
 * (not rendered yet). A pi `toolResult` is its own top-level entry (unlike
 * Claude Code, where tool_result rides inside a role:user message) — mapped
 * here to a synthetic role:'user' DTO carrying a single tool_result block, so
 * it fits the same `'user' | 'assistant'` DTO role Claude Code uses for the
 * same concept (a tool result is conversationally "the user side" replying
 * with the tool's output).
 */
import type { ChatBlock, SessionChatMessageDTO } from '../shared/contract.js'

function blockFromRaw(raw: unknown): ChatBlock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>

  switch (b['type']) {
    case 'text': {
      const text = b['text']
      return typeof text === 'string' ? { type: 'text', text } : null
    }
    case 'toolCall': {
      const id = b['id']
      const name = b['name']
      if (typeof id !== 'string' || typeof name !== 'string') return null
      return { type: 'tool_use', id, name, input: b['arguments'] ?? {} }
    }
    default:
      // thinking / image / other future block kinds — not rendered yet.
      return null
  }
}

/** A ToolResultMessage's `content` is an array of text/image parts; flatten
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

/** entry.timestamp is an ISO string; message.timestamp (when present, e.g.
 *  UserMessage/AssistantMessage) is epoch ms. Either is accepted, entry-level
 *  preferred (present on every entry per the format doc). */
function resolveTs(entryTimestamp: unknown, messageTimestamp: unknown): number {
  const fromEntry = typeof entryTimestamp === 'string' ? Date.parse(entryTimestamp) : NaN
  if (Number.isFinite(fromEntry)) return fromEntry
  const fromMessage = typeof messageTimestamp === 'number' ? messageTimestamp : NaN
  return fromMessage
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
  if (obj['type'] !== 'message') return null // session header / other non-message entries

  const uuid = obj['id']
  if (typeof uuid !== 'string' || !uuid) return null

  const message = obj['message']
  if (typeof message !== 'object' || message === null) return null
  const msg = message as Record<string, unknown>

  const ts = resolveTs(obj['timestamp'], msg['timestamp'])
  if (!Number.isFinite(ts)) return null

  const role = msg['role']

  if (role === 'user' || role === 'assistant') {
    const blocks = blocksFromContent(msg['content'])
    if (blocks.length === 0) return null // e.g. a thinking-only turn — nothing to show
    return { uuid, role, blocks, ts }
  }

  if (role === 'toolResult') {
    const toolCallId = msg['toolCallId']
    if (typeof toolCallId !== 'string') return null
    const block: ChatBlock = {
      type: 'tool_result',
      toolUseId: toolCallId,
      content: toolResultContentToString(msg['content']),
    }
    if (msg['isError'] === true) block.isError = true
    return { uuid, role: 'user', blocks: [block], ts }
  }

  return null
}

/** Parse full (or tail) pi session JSONL content into chat messages, oldest
 *  first, skipping blank/malformed/non-message lines and lines with nothing
 *  renderable. */
export function parsePiChatMessages(raw: string): SessionChatMessageDTO[] {
  const messages: SessionChatMessageDTO[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseLine(trimmed)
    if (parsed) messages.push(parsed)
  }
  return messages
}
