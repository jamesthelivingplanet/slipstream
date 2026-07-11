/**
 * statusSentinel — pure parser for the status.json sentinel file written by
 * the slipstream CLI's status commands. Kept dependency-free so it's usable
 * both from the CLI process (Electron ABI) and from sessionManager.ts, and
 * so it's directly unit-testable under plain Node/vitest.
 */
import type { NeedsReason } from '../shared/contract.js'

export const STATUS_SENTINEL_FILE = 'status.json'

export type SignalState = 'needs' | 'done' | 'running'

export interface StatusSentinel {
  state: SignalState
  message?: string
  /** Why the session needs the user (FLO-104). Lenient: absent on legacy
   *  files and on states other than 'needs'; unknown values are dropped
   *  rather than failing the whole sentinel. */
  reason?: NeedsReason
  ts: number
}

const VALID_STATES: SignalState[] = ['needs', 'done', 'running']
const VALID_REASONS: NeedsReason[] = ['input', 'blocked', 'approval']

/**
 * Parse a status.json sentinel written by the slipstream CLI.
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
  const reason = obj['reason']
  if (typeof reason === 'string' && VALID_REASONS.includes(reason as NeedsReason)) {
    result.reason = reason as NeedsReason
  }
  return result
}
