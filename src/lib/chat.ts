import type {
  SessionChatMessageDTO,
  ChatBlock,
  DiffHunkDTO,
  DiffLineDTO,
} from '../../electron/shared/contract.js'

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

/** Pagination-relevant stats about the MAIN-THREAD (non-sidechain) subset of
 *  a fetched page of messages. `pageChatMessages` applies `limit` to
 *  main-thread messages only, then carries each main-thread message's
 *  associated subagent (`isSidechain: true`) messages along on top,
 *  ts-sorted into the same flat array — so a returned page can contain far
 *  more entries than `limit`, and `messages.length`/`messages[0].ts` are NOT
 *  reliable signals for "did we get a full page" or "what's the oldest
 *  cursor to page further back from" (TASK-N6X4R). A subagent runs DURING
 *  its spawning turn, so its own timestamps can even precede that turn's —
 *  `oldestMainTs` must come from a main-thread message specifically, never
 *  just `messages[0]`. `oldestMainTs` is `null` when the list has no
 *  main-thread messages at all (e.g. an all-sidechain slice) — callers fall
 *  back sensibly rather than crashing. */
export interface MainlineStats {
  mainCount: number
  oldestMainTs: number | null
}

export function mainlineStats(messages: SessionChatMessageDTO[]): MainlineStats {
  let mainCount = 0
  let oldestMainTs: number | null = null
  for (const msg of messages) {
    if (msg.isSidechain === true) continue
    mainCount++
    if (oldestMainTs === null || msg.ts < oldestMainTs) oldestMainTs = msg.ts
  }
  return { mainCount, oldestMainTs }
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

export interface ChatThinkingItem {
  kind: 'thinking'
  turnId: string // = this message's own uuid
  uuid: string
  role: 'user' | 'assistant'
  ts: number
  text: string
}

export interface ChatImageItem {
  kind: 'image'
  turnId: string // = this message's own uuid
  uuid: string
  role: 'user' | 'assistant'
  ts: number
  mediaType: string // defaulted to 'image/png' when the source block omitted it
  data: string // base64, no "data:" prefix
}

export type ChatViewItem = ChatTextItem | ChatActivityRun | ChatThinkingItem | ChatImageItem

/**
 * Flattens an ordered (already deduped+sorted — see mergeChatMessages) list of
 * transcript DTOs into a renderer-ready item stream:
 *  - Sidechain messages (`isSidechain: true` — a Claude Code subagent's own
 *    transcript turns) are filtered out up front and never enter the main
 *    flow — they're nested separately by `buildSubagentGroups`. Backward
 *    compatible: `undefined !== true`, so callers that never set the flag are
 *    unaffected.
 *  - `text` blocks become a `ChatTextItem` each — these are always turn/run
 *    boundaries.
 *  - `thinking` blocks become a `ChatThinkingItem` each — also a turn/run
 *    boundary (a thinking block marks a turn transition just like text, it's
 *    not part of a tool-call sequence), so it closes any open run the same
 *    way `text` does.
 *  - `image` blocks become a `ChatImageItem` each — also a turn/run boundary,
 *    same treatment as `text`/`thinking`. `mediaType` defaults to
 *    `'image/png'` when the source block omitted it.
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
 *    Only a `text`/`thinking`/`image` block (from any message) closes an open
 *    run.
 *  - Blocks are visited in (message ts order, then block array order within
 *    a message).
 */
export function buildChatView(messages: SessionChatMessageDTO[]): ChatViewItem[] {
  return flattenBlocks(messages.filter((msg) => msg.isSidechain !== true))
}

/**
 * The actual block-flattening logic (see buildChatView's doc comment for the
 * per-block-type rules) — factored out so buildSubagentGroups can reuse it
 * directly on a group of messages that are ALL isSidechain:true. Those
 * messages must not go through buildChatView's own isSidechain filter (which
 * would wipe out the entire group, since every message in it is a sidechain
 * turn by construction) — the filter is a MAIN-transcript concern, not a
 * property of the flattening algorithm itself.
 */
function flattenBlocks(mainline: SessionChatMessageDTO[]): ChatViewItem[] {
  // First pass: map tool_use.id -> its result, wherever the tool_result lands.
  const resultsByToolUseId = new Map<string, { content: string; isError?: boolean }>()
  for (const msg of mainline) {
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

  for (const msg of mainline) {
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
      } else if (block.type === 'thinking') {
        closeRun()
        out.push({
          kind: 'thinking',
          turnId: msg.uuid,
          uuid: msg.uuid,
          role: msg.role,
          ts: msg.ts,
          text: block.text,
        })
      } else if (block.type === 'image') {
        closeRun()
        out.push({
          kind: 'image',
          turnId: msg.uuid,
          uuid: msg.uuid,
          role: msg.role,
          ts: msg.ts,
          mediaType: block.mediaType ?? 'image/png',
          data: block.data,
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

/** One nested subagent transcript, keyed to either the `toolUseId` of the
 *  `Agent` tool_use that spawned it (an "attached" group) or standing alone
 *  (an "orphaned" group — see buildSubagentGroups). `id` is a stable, unique
 *  key for this group (`{#each}` key + expand/collapse key in the renderer)
 *  — derived from `sidechainId` when present, else the group's spawn
 *  tool_use id, else the deterministic fallback `'none'`. `parentUuid` is
 *  kept for backward compatibility with existing callers/tests: it's the
 *  group's spawn tool_use id (same value used to key `byToolUseId`).
 *  `turnCount` is the number of nested ChatViewItems (each is a turn/run
 *  boundary — a text, thinking, image, or activity run) — used by the
 *  renderer's collapsed-row label ("<description> · N turns"). `label`
 *  (from `sidechainDescription`) and `agentType` (from `sidechainAgentType`)
 *  surface the run's metadata when the backend stamped it. */
export interface ChatSubagentGroup {
  id: string
  parentUuid: string | undefined
  items: ChatViewItem[]
  turnCount: number
  label?: string
  agentType?: string
}

/**
 * Groups `isSidechain: true` messages (a Claude Code subagent's own
 * transcript turns) into per-run `ChatSubagentGroup`s, builds each group's
 * own nested view via `flattenBlocks` — the same block-flattening logic
 * `buildChatView` uses (a subagent's transcript has the same shape —
 * text/tool_use/tool_result/thinking/image — and its tool_result pairing is
 * self-contained within its own messages) — then decides whether each group
 * is "attached" (its spawning `Agent` tool_use is present somewhere in this
 * loaded page — returned keyed by that tool_use id in `byToolUseId`) or
 * "orphaned" (spawning tool_use not found — returned in `orphaned`, grouped
 * but not chronologically placed, so a partial page or missing parent never
 * silently drops content).
 *
 * GROUPING KEY: `sidechainId` (a stable per-subagent-run id the backend
 * stamps on every message of a subagent transcript file) when present — this
 * is the reliable key, because a subagent's transcript file can have gaps
 * (an unrenderable line the parser drops) that break the `parentUuid` chain
 * partway through, which previously fractured ONE subagent run into many
 * one-message groups. When `sidechainId` is absent (older data), fall back
 * to the prior behavior's outcome: walk `parentUuid` through other sidechain
 * messages in the list to the chain root, and bucket by that root's
 * `parentUuid` (or by `undefined` when there is none) — this keeps every
 * message of a still-intact chain in one group, and still buckets multiple
 * parentUuid-less messages together rather than each getting its own group.
 *
 * SPAWN TOOL_USE ID (what a group attaches by): `sidechainToolUseId` if any
 * message in the group carries it, else the chain root's `parentUuid`.
 *
 * ATTACHMENT: a tool_use id is "available" if it's the id of a tool_use
 * anywhere in the main `items` OR anywhere in any group's own flattened
 * nested items — the latter is what lets a NESTED subagent (one that
 * spawned its own subagent) attach inside its parent's transcript instead of
 * being dumped in `orphaned`; the renderer resolves it by threading
 * `byToolUseId` down through the recursive nested render.
 *
 * SELF-REFERENCE GUARD: the renderer (`ChatTurnList.svelte`) renders an
 * attached group via `<svelte:self>` keyed by the SAME `toolUseId` used to
 * expand it — so if a group's own spawn tool_use id were also found among
 * that group's OWN nested items, expanding it would recursively render the
 * group inside itself forever (an infinite loop that hangs the tab). A real
 * transcript can't produce this (a subagent cannot spawn itself), but
 * malformed/duplicated data could, so a group is never allowed to attach to
 * a tool_use id that lives inside its own `items` — such a group is treated
 * as orphaned instead.
 */
export function buildSubagentGroups(
  messages: SessionChatMessageDTO[],
  items: ChatViewItem[],
): { byToolUseId: Map<string, ChatSubagentGroup>; orphaned: ChatSubagentGroup[] } {
  const sidechainMessages = messages.filter((msg) => msg.isSidechain === true)

  // For the parentUuid-chain fallback: walk from `msg` through OTHER
  // sidechain messages (by uuid) to the chain root, returning the root's
  // own parentUuid. Guards against cycles defensively (malformed transcript)
  // via `seen`, even though a real transcript should never cycle.
  const byUuid = new Map<string, SessionChatMessageDTO>()
  for (const msg of sidechainMessages) byUuid.set(msg.uuid, msg)
  function chainRootParentUuid(msg: SessionChatMessageDTO): string | undefined {
    let current = msg
    const seen = new Set<string>()
    while (current.parentUuid !== undefined && !seen.has(current.uuid)) {
      seen.add(current.uuid)
      const next = byUuid.get(current.parentUuid)
      if (!next) break
      current = next
    }
    return current.parentUuid
  }

  // Bucket sidechain messages: sidechainId when present, else the
  // parentUuid-chain-root fallback (grouped under a key that still collapses
  // "no parentUuid at all" messages into one bucket, matching prior
  // behavior).
  const bucketsByKey = new Map<string, SessionChatMessageDTO[]>()
  const keyOrder: string[] = []
  for (const msg of sidechainMessages) {
    const key =
      msg.sidechainId !== undefined
        ? `sc:${msg.sidechainId}`
        : `root:${chainRootParentUuid(msg) ?? ''}`
    let bucket = bucketsByKey.get(key)
    if (!bucket) {
      bucket = []
      bucketsByKey.set(key, bucket)
      keyOrder.push(key)
    }
    bucket.push(msg)
  }

  const groups: ChatSubagentGroup[] = []
  for (const key of keyOrder) {
    const groupMessages = bucketsByKey.get(key)!
    const nestedItems = flattenBlocks(groupMessages)
    const sidechainToolUseId = groupMessages
      .map((m) => m.sidechainToolUseId)
      .find((v) => v !== undefined)
    const spawnToolUseId = sidechainToolUseId ?? chainRootParentUuid(groupMessages[0])
    const sidechainId = groupMessages.map((m) => m.sidechainId).find((v) => v !== undefined)
    const label = groupMessages.map((m) => m.sidechainDescription).find((v) => v !== undefined)
    const agentType = groupMessages.map((m) => m.sidechainAgentType).find((v) => v !== undefined)
    groups.push({
      id: sidechainId ?? spawnToolUseId ?? 'none',
      parentUuid: spawnToolUseId,
      items: nestedItems,
      turnCount: nestedItems.length,
      label,
      agentType,
    })
  }

  // A tool_use id is "available" (something a group can attach to) if it's
  // in the main flattened items OR inside any group's own nested items — the
  // latter makes a nested subagent (one spawned from inside another
  // subagent's transcript) attach to its parent group instead of orphaning.
  const availableToolUseIds = new Set<string>()
  for (const item of items) {
    if (item.kind === 'activity') {
      for (const toolItem of item.items) availableToolUseIds.add(toolItem.toolUseId)
    }
  }
  for (const group of groups) {
    for (const item of group.items) {
      if (item.kind === 'activity') {
        for (const toolItem of item.items) availableToolUseIds.add(toolItem.toolUseId)
      }
    }
  }

  const byToolUseId = new Map<string, ChatSubagentGroup>()
  const orphaned: ChatSubagentGroup[] = []
  for (const group of groups) {
    // Per-group set of this group's OWN tool_use ids — used only for the
    // self-reference guard below (see SELF-REFERENCE GUARD doc above).
    const ownToolUseIds = new Set<string>()
    for (const item of group.items) {
      if (item.kind === 'activity') {
        for (const toolItem of item.items) ownToolUseIds.add(toolItem.toolUseId)
      }
    }
    const selfReferential = group.parentUuid !== undefined && ownToolUseIds.has(group.parentUuid)

    if (
      !selfReferential &&
      group.parentUuid !== undefined &&
      availableToolUseIds.has(group.parentUuid)
    ) {
      byToolUseId.set(group.parentUuid, group)
    } else {
      // Either no spawn tool_use id at all, it isn't present anywhere in
      // this loaded page, or it's self-referential (guarded above) — orphaned,
      // but never dropped.
      orphaned.push(group)
    }
  }

  return { byToolUseId, orphaned }
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
    case 'Agent': {
      // Subagent spawn (TASK-N6X4R) — same description->prompt->fallback
      // pattern as Task above. This summary does double duty as the
      // collapsed-row label for the nested subagent group (see
      // buildSubagentGroups), so it needs to read well standalone.
      const description = fieldAsString(input, 'description')
      if (description !== undefined) return `Delegated to subagent: ${description}`
      const prompt = fieldAsString(input, 'prompt')
      return prompt !== undefined ? `Delegated to subagent: ${prompt}` : fallback
    }
    case 'ToolSearch': {
      const query = fieldAsString(input, 'query')
      return query !== undefined ? `Searched tools for "${query}"` : fallback
    }
    case 'Skill': {
      // Field is `skill`, not `name` (TASK-N6X4R, confirmed against real
      // transcripts).
      const skill = fieldAsString(input, 'skill')
      return skill !== undefined ? `Invoked skill: ${skill}` : fallback
    }
    case 'AskUserQuestion': {
      // No single top-level "text" field — it's an array of question objects,
      // each with `question`/`header` (TASK-N6X4R, confirmed). Use the first
      // question's `header` (short, meant for exactly this kind of label);
      // fall back to its `question` (full text) if header is missing, and to
      // the generic fallback if the array is empty/malformed.
      if (input === null || typeof input !== 'object') return fallback
      const questions = (input as Record<string, unknown>).questions
      if (!Array.isArray(questions) || questions.length === 0) return fallback
      const first = questions[0]
      if (first === null || typeof first !== 'object') return fallback
      const header = (first as Record<string, unknown>).header
      if (typeof header === 'string' && header.length > 0) return `Asked: ${header}`
      const question = (first as Record<string, unknown>).question
      return typeof question === 'string' && question.length > 0 ? `Asked: ${question}` : fallback
    }
    case 'TaskCreate': {
      const subject = fieldAsString(input, 'subject')
      if (subject !== undefined) return `Added task: ${subject}`
      const description = fieldAsString(input, 'description')
      return description !== undefined ? `Added task: ${description}` : fallback
    }
    case 'TaskUpdate': {
      // No `subject` field on TaskUpdate in any real sample (TASK-N6X4R) — do
      // not invent one. The id shows up as EITHER `taskId` or `task_id`
      // (inconsistent across real calls) — accept either.
      const status = fieldAsString(input, 'status')
      if (status === undefined) return fallback
      const taskId = fieldAsString(input, 'taskId') ?? fieldAsString(input, 'task_id')
      return taskId !== undefined
        ? `Marked task ${taskId} as ${status}`
        : `Marked task as ${status}`
    }
    case 'SendMessage': {
      const to = fieldAsString(input, 'to')
      const summary = fieldAsString(input, 'summary')
      return to !== undefined && summary !== undefined ? `Sent ${to}: ${summary}` : fallback
    }
    default: {
      // Generic mcp__<server>__<tool> pattern (e.g. mcp__slipstream__report_status,
      // mcp__linear__save_issue) — parse into "<server>: <tool>" rather than
      // dumping the raw underscore-mangled name. This must stay generic (any
      // mcp tool name), not a per-tool case. Falls through to the plain `Used
      // <name>` fallback if the name doesn't match the exact 3-part shape.
      const parts = name.split('__')
      if (parts.length === 3 && parts[0] === 'mcp' && parts[1].length > 0 && parts[2].length > 0) {
        return `${parts[1]}: ${parts[2]}`
      }
      return fallback
    }
  }
}

/** Splits text on '\n' into per-line DiffLineDTOs, all of one `kind`, numbered
 *  sequentially from 1 in the axis that `kind` owns (del -> oldLine, add ->
 *  newLine) — real file positions are unknowable from a bare `old_string`/
 *  `new_string`/`content` blob, so sequential numbering is the best available.
 *  A single trailing '\n' is treated as terminating the last line (not as an
 *  extra blank line), matching how these strings are normally composed. */
function linesToDiffLines(text: string, kind: 'add' | 'del'): DiffLineDTO[] {
  const raw = text.split('\n')
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()
  return raw.map((lineText, i) => ({
    kind,
    text: lineText,
    oldLine: kind === 'del' ? i + 1 : null,
    newLine: kind === 'add' ? i + 1 : null,
  }))
}

/**
 * Renders an Edit tool_use's `input` as a single whole-block replace diff:
 * `old_string`'s lines as deletions followed by `new_string`'s lines as
 * additions. No LCS/minimal-diff — out of scope (no diff library in this
 * repo). `header`/`oldStart`/`newStart` don't claim real file line numbers
 * (unknowable from `old_string`/`new_string` alone), hence the generic
 * `@@ Edit @@` header rather than a fabricated `@@ -a,b +c,d @@`.
 * Returns `null` (never throws) whenever `input` doesn't have the expected
 * shape, so the caller falls back to the raw JSON dump.
 */
export function toolEditHunks(input: unknown): DiffHunkDTO[] | null {
  const oldString = fieldAsString(input, 'old_string')
  const newString = fieldAsString(input, 'new_string')
  if (oldString === undefined || newString === undefined) return null
  return [
    {
      header: '@@ Edit @@',
      oldStart: 1,
      newStart: 1,
      lines: [...linesToDiffLines(oldString, 'del'), ...linesToDiffLines(newString, 'add')],
    },
  ]
}

/**
 * Renders a Write tool_use's `input.content` as pure additions (a new file
 * being written in full). Same defensive contract as `toolEditHunks`.
 */
export function toolWriteHunks(input: unknown): DiffHunkDTO[] | null {
  const content = fieldAsString(input, 'content')
  if (content === undefined) return null
  return [
    {
      header: '@@ Write @@',
      oldStart: 1,
      newStart: 1,
      lines: linesToDiffLines(content, 'add'),
    },
  ]
}

export interface ChatTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Parses a TodoWrite tool_use's `input.todos` into a renderable checklist.
 *
 * UNVERIFIED locally (TASK-N6X4R): this machine's real Claude Code transcript
 * history has zero genuine TodoWrite calls to confirm field names against —
 * every local session uses a differently-named tool (TaskCreate/TaskUpdate,
 * with subject/description/activeForm fields, no `todos` array) instead. This
 * implements the well-known standard Claude Code TodoWrite schema:
 * `{ content: string, status: 'pending'|'in_progress'|'completed' }[]`.
 *
 * A single malformed item is skipped rather than falling the *whole* array
 * back to the JSON dump: a todo list is normally mostly well-formed, and
 * dropping just the bad entry keeps the (more useful) checklist view for the
 * rest rather than discarding it over one bad item. Never throws; returns
 * `null` when `todos` is missing/not an array/every item is malformed, so the
 * caller falls back to the JSON dump.
 */
export function toolTodos(input: unknown): ChatTodoItem[] | null {
  if (input === null || typeof input !== 'object') return null
  const todos = (input as Record<string, unknown>).todos
  if (!Array.isArray(todos)) return null
  const out: ChatTodoItem[] = []
  for (const item of todos) {
    if (item === null || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    const status = (item as Record<string, unknown>).status
    if (typeof content !== 'string' || content.length === 0) continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    out.push({ content, status })
  }
  return out.length > 0 ? out : null
}

/** What ChatView should show in place of the transcript, or `null` to render
 *  it normally. `available:false` (from the `getChatMessages` RPC) covers two
 *  different situations that need different copy — a backend with no chat
 *  reader at all (`supportsChat:false`, e.g. antigravity/grok — chat can
 *  NEVER populate there) vs. one that has a reader but nothing recoverable
 *  yet (transcript not written, server not up) — so `supportsChat` must be
 *  checked first; `available` alone can't tell them apart (TASK-N6X4R). */
export type ChatEmptyState = 'unsupported' | 'waiting' | 'empty' | null

/**
 * Pure decision for which empty-state (if any) ChatView renders, given the
 * agent's chat-support flag, the backend's `available` probe result, and
 * whether any messages have loaded so far.
 */
export function chatEmptyState(
  supportsChat: boolean,
  available: boolean,
  hasMessages: boolean,
): ChatEmptyState {
  if (!supportsChat) return 'unsupported' // this kind has no chat reader — never invite a message
  if (!available) return 'waiting' // has a reader, but nothing recoverable yet
  if (!hasMessages) return 'empty' // genuinely empty conversation — the invite copy is correct here
  return null
}

// Re-export so callers importing purely from this module can still name the
// block type without reaching into the contract directly.
export type { ChatBlock, DiffHunkDTO, DiffLineDTO }
