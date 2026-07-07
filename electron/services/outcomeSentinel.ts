/**
 * outcomeSentinel — pure parser for the outcome.json sentinel file written by
 * the app MCP's `report_outcome` tool. Kept dependency-free so it's usable
 * both from the MCP process (Electron ABI) and from sessionManager.ts, and
 * so it's directly unit-testable under plain Node/vitest.
 */

import type { OutcomeResult } from '../shared/contract.js'

export const OUTCOME_SENTINEL_FILE = 'outcome.json'

export interface OutcomeSentinel {
  result: OutcomeResult
  summary: string
  details?: string
  ts: number
}

const VALID_RESULTS: OutcomeResult[] = ['success', 'partial', 'failure']

// Defensive length caps — mirror the caps applied in appMcp.ts's report_outcome
// handler, but enforced again here since the sentinel file could in principle
// be written some other way.
const MAX_SUMMARY_LEN = 4000
const MAX_DETAILS_LEN = 32000

/**
 * Parse an outcome.json sentinel written by the app MCP's report_outcome tool.
 * Returns null for malformed JSON, unknown result, empty summary, or
 * missing/invalid ts. Truncates summary/details defensively.
 */
export function parseOutcomeSentinel(raw: string): OutcomeSentinel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const result = obj['result']
  if (typeof result !== 'string' || !VALID_RESULTS.includes(result as OutcomeResult)) return null

  const summary = obj['summary']
  if (typeof summary !== 'string' || summary.length === 0) return null

  const details = obj['details']
  if (details !== undefined && typeof details !== 'string') return null

  const ts = obj['ts']
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null

  const sentinel: OutcomeSentinel = {
    result: result as OutcomeResult,
    summary: summary.slice(0, MAX_SUMMARY_LEN),
    ts,
  }
  if (typeof details === 'string') sentinel.details = details.slice(0, MAX_DETAILS_LEN)
  return sentinel
}
