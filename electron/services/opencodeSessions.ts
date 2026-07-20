import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { ChatBlock, SessionChatMessageDTO, SessionStatus } from '../shared/contract.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'
import {
  OPENCODE_FLAGS,
  OPENCODE_SESSION_CAPTURE_ATTEMPTS,
  OPENCODE_SESSION_CAPTURE_INTERVAL_MS,
  OPENCODE_BIN_NAME,
} from '../shared/agentCli.js'

/** Resolve the opencode binary, preferring a local node_modules/.bin copy. */
const OPENCODE_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'opencode')
  return existsSync(local) ? local : OPENCODE_BIN_NAME
})()

export interface OpencodeSession {
  id: string
  time_created?: number
  time_updated?: number
  title?: string
}

/** Minimal shape of an opencode message we read to classify status / render
 *  chat (TASK-FPH60). `id`/`time.created` and the tool-part fields are only
 *  used by the chat mapping below — status classification ignores them. */
export interface OpencodeMessagePart {
  type: string
  text?: string
  /** Present on `type: 'tool'` parts — opencode's own part id, or the
   *  provider's tool-call id when different. Either identifies the call. */
  id?: string
  callID?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
  }
}
export interface OpencodeMessageInfo {
  id?: string
  role?: string
  time?: { created?: number }
}
export interface OpencodeMessage {
  info?: OpencodeMessageInfo
  parts?: OpencodeMessagePart[]
}

/**
 * Pure: newest session id whose time_created >= sinceMs, or null.
 * Exported so selection logic is unit-tested without network access.
 */
export function selectNewestSessionSince(
  sessions: OpencodeSession[],
  sinceMs: number,
): string | null {
  let best: OpencodeSession | null = null
  for (const s of sessions) {
    const t = s.time_created ?? 0
    if (t >= sinceMs && (!best || t > (best.time_created ?? 0))) {
      best = s
    }
  }
  return best?.id ?? null
}

/**
 * Append opencode's `--prompt` flag so the TUI auto-starts on `prompt`.
 *
 * The TUI ignores keystrokes typed before its input box has rendered (startup
 * takes several seconds), so feeding the prompt by writing to the PTY after a
 * fixed delay races initialization and the run often never starts. `--prompt`
 * submits the message on launch, independent of how long the TUI took to come
 * up. Returns `args` unchanged when there is no prompt so the TUI opens to an
 * empty input (the resume/continue path, which must not auto-submit).
 */
export function withOpencodePromptArg(args: string[], prompt: string | null | undefined): string[] {
  return prompt ? [...args, OPENCODE_FLAGS.prompt, prompt] : args
}

/**
 * Fetch the session list from an opencode TUI's embedded server (launched with
 * --port). Returns [] on any error (server still starting, unreachable, etc.).
 */
export async function listOpencodeSessions(port: number): Promise<OpencodeSession[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`)
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? (data as OpencodeSession[]) : []
  } catch {
    return []
  }
}

/**
 * Parse the stdout of `opencode session list --format json -n 1` into a session
 * id. Returns null on any parse failure or empty result.
 * Pure — exported so it's unit-testable without spawning processes.
 */
export function parseOpencodeSessionIdFromStdout(stdout: string): string | null {
  try {
    const arr = JSON.parse(stdout.trim())
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0].id === 'string') {
      return arr[0].id
    }
  } catch {
    // parse failure — session file may not exist yet
  }
  return null
}

/**
 * Shell out to `<bin> session list --format json -n 1` to read the newest
 * session id from the CLI's on-disk session store. Returns null on any error
 * (binary missing, no sessions yet, parse failure).
 *
 * Must run in the worktree directory so the CLI scopes to the correct
 * project — sessions are per-directory, not global. `bin` defaults to
 * opencode's resolved binary; Kilo Code (an opencode fork) reuses this
 * unchanged with its own resolved binary — same subcommand, same flags, same
 * stdout shape.
 */
export async function queryOpencodeSessionIdFromCli(
  cwd: string,
  bin: string = OPENCODE_BIN,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['session', 'list', '--format', 'json', '-n', '1'],
      { timeout: 10_000, cwd },
      (err, stdout) => {
        if (err) return resolve(null)
        resolve(parseOpencodeSessionIdFromStdout(stdout))
      },
    )
    child.on('error', () => resolve(null))
  })
}

/**
 * Poll `<bin> session list` until a session appears. The TUI creates its
 * session shortly after launch (and on first message), so this retries until
 * the on-disk session store has an entry, or attempts run out.
 *
 * Uses the CLI instead of the HTTP server, so it works even when the embedded
 * server is slow to start. `bin` defaults to opencode's resolved binary; Kilo
 * Code passes its own resolved binary (see agentBackend.ts's KILO_BIN).
 */
export async function captureOpencodeSessionId(opts: {
  cwd: string
  attempts?: number
  intervalMs?: number
  bin?: string
}): Promise<string | null> {
  const attempts = opts.attempts ?? OPENCODE_SESSION_CAPTURE_ATTEMPTS
  const intervalMs = opts.intervalMs ?? OPENCODE_SESSION_CAPTURE_INTERVAL_MS
  for (let i = 0; i < attempts; i++) {
    const id = await queryOpencodeSessionIdFromCli(opts.cwd, opts.bin)
    if (id) return id
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

/**
 * Fetch the message history for an opencode session from its embedded server.
 * Returns [] on any error (server unreachable, session missing, etc.).
 */
export async function fetchOpencodeMessages(port: number, sid: string): Promise<OpencodeMessage[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(sid)}/message`)
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? (data as OpencodeMessage[]) : []
  } catch {
    return []
  }
}

/**
 * Classify an opencode session's status from its assistant text by honoring the
 * most recently emitted Slipstream state marker (same semantics the PTY-based
 * StatusDetector uses for Claude Code). The last marker in the stream wins;
 * when no marker is present the agent is assumed to still be in progress.
 *
 * Pure — exported so the classification is unit-testable without network.
 */
export function opencodeStatusFromText(text: string): SessionStatus {
  const candidates: [string, SessionStatus][] = [
    [DONE_MARKER, 'done'],
    [NEEDS_INPUT_MARKER, 'needs'],
    [IN_PROGRESS_MARKER, 'running'],
  ]
  let bestIdx = -1
  let bestStatus: SessionStatus = 'running'
  for (const [marker, status] of candidates) {
    const idx = text.lastIndexOf(marker)
    if (idx !== -1 && idx > bestIdx) {
      bestIdx = idx
      bestStatus = status
    }
  }
  return bestStatus
}

/**
 * Concatenate assistant text parts (in order) and classify via the markers.
 * The opencode server returns clean message text — unlike the TUI's PTY
 * stream, the markers survive reliably here, which is what makes accurate
 * Done / Needs You / In Progress filtering possible for opencode runs.
 */
export function opencodeStatusFromMessages(messages: OpencodeMessage[]): SessionStatus {
  let text = ''
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && typeof p.text === 'string') text += '\n' + p.text
    }
  }
  return opencodeStatusFromText(text)
}

/* ───────── Chat mapping (TASK-FPH60 opencode extension) ─────────
 * opencode has no transcript file to tail — messages come from its embedded
 * server (fetchOpencodeMessages above), polled by sessionManager. These pure
 * functions map that response shape to SessionChatMessageDTO, mirroring
 * transcriptMessages.ts / piChatMessages.ts. */

/** Best-effort stringify of a tool part's output for display: pass strings
 *  through, JSON-stringify anything else, '' for null/undefined/unstringifiable. */
function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return ''
  }
}

/** A `type: 'tool'` part carries both the call and (once resolved) its
 *  result in one object — unlike Claude Code's separate tool_use/tool_result
 *  transcript lines. Split it into a tool_use block, plus a tool_result block
 *  once `state.status` indicates the call finished (completed or errored);
 *  a still-pending/running call renders as just the tool_use. Returns []
 *  when the part lacks enough identity to render (no id, no tool name). */
function blocksFromToolPart(part: OpencodeMessagePart): ChatBlock[] {
  const id = part.callID ?? part.id
  const name = part.tool
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return []

  const blocks: ChatBlock[] = [{ type: 'tool_use', id, name, input: part.state?.input ?? {} }]
  const status = part.state?.status
  if (status === 'completed' || status === 'error') {
    const block: ChatBlock = {
      type: 'tool_result',
      toolUseId: id,
      content: stringifyToolOutput(part.state?.output),
    }
    if (status === 'error') block.isError = true
    blocks.push(block)
  }
  return blocks
}

function blocksFromParts(parts: OpencodeMessagePart[] | undefined): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const part of parts ?? []) {
    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text })
      }
    } else if (part.type === 'tool') {
      blocks.push(...blocksFromToolPart(part))
    }
    // other part kinds (reasoning, step-start/finish, file, ...) aren't
    // rendered yet — skipped leniently.
  }
  return blocks
}

/** Pure: map one opencode message to a chat DTO, or null when it's not a
 *  user/assistant turn, has no stable id, or has nothing renderable. */
export function opencodeMessageToChat(msg: OpencodeMessage): SessionChatMessageDTO | null {
  const role = msg.info?.role
  if (role !== 'user' && role !== 'assistant') return null
  const uuid = msg.info?.id
  if (typeof uuid !== 'string' || !uuid) return null
  const blocks = blocksFromParts(msg.parts)
  if (blocks.length === 0) return null
  const created = msg.info?.time?.created
  return { uuid, role, blocks, ts: typeof created === 'number' ? created : 0 }
}

/** Pure: map + filter a full message list, in order (oldest first, matching
 *  the server's response order). */
export function opencodeMessagesToChat(messages: OpencodeMessage[]): SessionChatMessageDTO[] {
  const out: SessionChatMessageDTO[] = []
  for (const m of messages) {
    const dto = opencodeMessageToChat(m)
    if (dto) out.push(dto)
  }
  return out
}
