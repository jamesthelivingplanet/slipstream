import type { SessionStatus } from '../shared/contract.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

export interface OpencodeSession {
  id: string
  time_created?: number
  time_updated?: number
  title?: string
}

/** Minimal shape of an opencode message we read to classify status. */
export interface OpencodeMessagePart {
  type: string
  text?: string
}
export interface OpencodeMessage {
  info?: { role?: string }
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
 * Poll the opencode server for the session id created at/after sinceMs. The TUI
 * creates its session shortly after launch (and on first message), so this
 * retries until the server is up and the session appears, or attempts run out.
 */
export async function captureOpencodeSessionId(
  port: number,
  sinceMs: number,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? 20
  const intervalMs = opts.intervalMs ?? 500
  for (let i = 0; i < attempts; i++) {
    const id = selectNewestSessionSince(await listOpencodeSessions(port), sinceMs)
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
