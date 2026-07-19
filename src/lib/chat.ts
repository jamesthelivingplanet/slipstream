import type { SessionChatMessageDTO, ChatBlock } from '../../electron/shared/contract.js'

/** Merge an older/newer page of messages into an existing list: dedupe by
 *  `uuid` (last write wins — a message from `incoming` replaces one with the
 *  same uuid in `existing`), then sort ascending by `ts`. Used both to
 *  prepend an older page (pagination, scroll-to-top) and to append a single
 *  live-pushed message (onChatMessage) — same merge either direction. */
export function mergeChatMessages(
  existing: SessionChatMessageDTO[],
  incoming: SessionChatMessageDTO[],
): SessionChatMessageDTO[] {
  const byUuid = new Map<string, SessionChatMessageDTO>()
  for (const msg of existing) byUuid.set(msg.uuid, msg)
  for (const msg of incoming) byUuid.set(msg.uuid, msg) // incoming wins on conflict
  return [...byUuid.values()].sort((a, b) => a.ts - b.ts)
}

export interface ChatToolActivityItem {
  toolUseId: string
  name: string
  input: unknown
  /** null until/unless a matching tool_result block has arrived anywhere in the message list. */
  result: { content: string; isError?: boolean } | null
  summary: string // see summarizeTool
}

export interface ChatActivityRun {
  kind: 'activity'
  /** uuid of the message that contained the FIRST tool_use in this run — lets the
   *  renderer draw a "turn spine" connecting this activity to the reply it belongs to. */
  turnId: string
  items: ChatToolActivityItem[]
}

export interface ChatTextItem {
  kind: 'text'
  turnId: string // = this message's own uuid
  uuid: string
  role: 'user' | 'assistant'
  ts: number
  text: string
}

export type ChatViewItem = ChatTextItem | ChatActivityRun

/**
 * Flattens an ordered (already deduped+sorted — see mergeChatMessages) list of
 * transcript DTOs into a renderer-ready item stream:
 *  - `text` blocks become a `ChatTextItem` each — these are always turn/run
 *    boundaries.
 *  - `tool_use` blocks are paired with their `tool_result` by matching
 *    `tool_use.id` === `tool_result.toolUseId`, searched across ALL messages
 *    (not just the current one or later ones — the result may already be
 *    present earlier in a re-fetched page, or arrive later live; either way
 *    do a full first pass to build an id -> result map before emitting items).
 *  - `tool_result` blocks NEVER produce their own ChatViewItem — they're
 *    folded into the paired tool_use's `result` field, or silently dropped if
 *    no matching tool_use exists (defensive — malformed/partial transcript).
 *  - Consecutive tool_use blocks are grouped into ONE ChatActivityRun. "Consecutive"
 *    is defined on the flattened block stream in message order, where
 *    tool_result blocks are invisible (they don't break a run, since a
 *    tool_result for call A routinely arrives as its own separate DTO
 *    sandwiched between the DTO for tool_use A and the DTO for the next
 *    tool_use B — that must still produce ONE run containing [A, B], not two).
 *    Only a `text` block (from any message) closes an open run.
 *  - Blocks are visited in (message ts order, then block array order within
 *    a message).
 */
export function buildChatView(messages: SessionChatMessageDTO[]): ChatViewItem[] {
  // First pass: map tool_use.id -> its result, wherever the tool_result lands.
  const resultsByToolUseId = new Map<string, { content: string; isError?: boolean }>()
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'tool_result') {
        resultsByToolUseId.set(block.toolUseId, { content: block.content, isError: block.isError })
      }
    }
  }

  const out: ChatViewItem[] = []
  let openRun: ChatActivityRun | null = null

  const closeRun = () => {
    if (openRun) {
      out.push(openRun)
      openRun = null
    }
  }

  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'text') {
        closeRun()
        out.push({
          kind: 'text',
          turnId: msg.uuid,
          uuid: msg.uuid,
          role: msg.role,
          ts: msg.ts,
          text: block.text,
        })
      } else if (block.type === 'tool_use') {
        if (!openRun) {
          openRun = { kind: 'activity', turnId: msg.uuid, items: [] }
        }
        openRun.items.push({
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          result: resultsByToolUseId.get(block.id) ?? null,
          summary: summarizeTool(block.name, block.input),
        })
      }
      // tool_result blocks are invisible here — already folded above, and they
      // never break or close a run.
    }
  }
  closeRun()

  return out
}

function fieldAsString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Pure one-line summary for a tool_use, given its Claude Code tool `name` and
 * `input` (untyped passthrough from the transcript — validate shape
 * defensively, never throw, fall back to the default for any unexpected
 * shape).
 */
export function summarizeTool(name: string, input: unknown): string {
  const fallback = `Used ${name}`

  switch (name) {
    case 'Edit': {
      const filePath = fieldAsString(input, 'file_path')
      return filePath !== undefined ? `Edited ${filePath}` : fallback
    }
    case 'Write': {
      const filePath = fieldAsString(input, 'file_path')
      return filePath !== undefined ? `Wrote ${filePath}` : fallback
    }
    case 'Read': {
      const filePath = fieldAsString(input, 'file_path')
      return filePath !== undefined ? `Read ${filePath}` : fallback
    }
    case 'Bash': {
      const description = fieldAsString(input, 'description')
      if (description !== undefined && description.length > 0) return description
      const command = fieldAsString(input, 'command')
      return command !== undefined ? `Ran ${truncate(command, 60)}` : fallback
    }
    case 'Grep': {
      const pattern = fieldAsString(input, 'pattern')
      return pattern !== undefined ? `Searched for "${pattern}"` : fallback
    }
    case 'Glob': {
      const pattern = fieldAsString(input, 'pattern')
      return pattern !== undefined ? `Searched files matching ${pattern}` : fallback
    }
    case 'WebFetch': {
      const url = fieldAsString(input, 'url')
      return url !== undefined ? `Fetched ${url}` : fallback
    }
    case 'WebSearch': {
      const query = fieldAsString(input, 'query')
      return query !== undefined ? `Searched the web for "${query}"` : fallback
    }
    case 'TodoWrite':
      return 'Updated the task list'
    case 'Task': {
      const description = fieldAsString(input, 'description')
      if (description !== undefined) return `Delegated: ${description}`
      const prompt = fieldAsString(input, 'prompt')
      return prompt !== undefined ? `Delegated: ${prompt}` : fallback
    }
    case 'NotebookEdit': {
      const notebookPath = fieldAsString(input, 'notebook_path')
      return notebookPath !== undefined ? `Edited ${notebookPath}` : fallback
    }
    default:
      return fallback
  }
}

// Re-export so callers importing purely from this module can still name the
// block type without reaching into the contract directly.
export type { ChatBlock }
