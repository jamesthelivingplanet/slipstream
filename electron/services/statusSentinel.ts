/**
 * statusSentinel — pure parser for the status.json sentinel file written by
 * the app MCP's `report_status` tool. Kept dependency-free so it's usable
 * both from the MCP process (Electron ABI) and from sessionManager.ts, and
 * so it's directly unit-testable under plain Node/vitest.
 */

export const STATUS_SENTINEL_FILE = 'status.json'

export type SignalState = 'needs' | 'done' | 'running'

export interface StatusSentinel {
  state: SignalState
  message?: string
  ts: number
}

const VALID_STATES: SignalState[] = ['needs', 'done', 'running']

/**
 * Parse a status.json sentinel written by the app MCP's report_status tool.
 * Returns null for malformed JSON, unknown state, or missing/invalid ts.
 */
export function parseStatusSentinel(raw: string): StatusSentinel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const state = obj['state']
  if (typeof state !== 'string' || !VALID_STATES.includes(state as SignalState)) return null

  const ts = obj['ts']
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null

  const message = obj['message']
  if (message !== undefined && typeof message !== 'string') return null

  const result: StatusSentinel = { state: state as SignalState, ts }
  if (typeof message === 'string') result.message = message
  return result
}
