/**
 * agentEventsSentinel — pure parser for the events.ndjson sentinel appended by
 * the slipstream CLI (checkpoint / artifact / approval, FLO-104). One file for
 * all kinds keeps the sessionManager watcher to a single extra branch.
 *
 * Dependency-free (usable from both the CLI process and sessionManager) and
 * lenient: malformed or partially-written trailing lines are skipped, not
 * fatal — the watcher (sentinelWatcher.ts) re-reads the whole file on the
 * next fs event and its own ts-cursor dedupes what was already delivered.
 */
import type { AgentEventKind } from '../shared/contract.js'

export const AGENT_EVENTS_FILE = 'events.ndjson'

const VALID_KINDS: AgentEventKind[] = ['checkpoint', 'artifact', 'approval']

/** One parsed events.ndjson line (sessionId is added by the reader — the file
 *  lives inside the session's own sentinel dir, so lines don't repeat it). */
export interface AgentEventLine {
  kind: AgentEventKind
  message?: string
  path?: string
  ts: number
}

function parseLine(line: string): AgentEventLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const kind = obj['kind']
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as AgentEventKind)) return null

  const ts = obj['ts']
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null

  const result: AgentEventLine = { kind: kind as AgentEventKind, ts }
  if (typeof obj['message'] === 'string') result.message = obj['message'] as string
  if (typeof obj['path'] === 'string') result.path = obj['path'] as string
  return result
}

/** Parse the full NDJSON content, skipping blank/malformed lines. */
export function parseAgentEvents(raw: string): AgentEventLine[] {
  const events: AgentEventLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseLine(trimmed)
    if (parsed) events.push(parsed)
  }
  return events
}
