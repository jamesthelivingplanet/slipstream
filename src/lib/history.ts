/**
 * Run history — pure helpers for the history view (FLO-97).
 *
 * Framework-free filtering/formatting logic for `SessionHistoryEntry[]`, kept
 * separate from `HistoryView.svelte` so it's cheaply unit-testable (mirrors
 * the split in `missionControl.ts`).
 */

import type { SessionHistoryEntry, OutcomeResult } from '../../electron/shared/contract.js'

// ─── Filtering ────────────────────────────────────────────────────────────────

export interface HistoryFilterOpts {
  repoId?: string | null
  result?: OutcomeResult | 'none' | null
  query?: string
}

/** Filter history entries by repo, outcome result, and/or a free-text search
 *  across title/prompt/tid/branch/outcome summary. Every dimension is
 *  optional and falsy/empty values are a no-op (don't filter on that axis).
 *  Order is preserved — this filters, it doesn't sort. */
export function filterHistory(
  entries: SessionHistoryEntry[],
  opts: HistoryFilterOpts,
): SessionHistoryEntry[] {
  const repoId = opts.repoId
  const result = opts.result
  const q = opts.query?.trim().toLowerCase()

  return entries.filter((entry) => {
    if (repoId && entry.session.repoId !== repoId) return false

    if (result) {
      if (result === 'none') {
        if (entry.outcome !== null) return false
      } else if (entry.outcome?.result !== result) {
        return false
      }
    }

    if (q) {
      const haystacks = [
        entry.session.title,
        entry.session.prompt,
        entry.session.tid,
        entry.session.branch,
        entry.outcome?.summary ?? '',
      ]
      const matches = haystacks.some((h) => (h ?? '').toLowerCase().includes(q))
      if (!matches) return false
    }

    return true
  })
}

// ─── Date formatting ──────────────────────────────────────────────────────────

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Compact local-time timestamp for a history row:
 * - same local calendar day as `now` -> 'HH:MM' (24h, zero-padded)
 * - same local calendar year as `now` -> 'Mon D' (no leading zero, no year)
 * - otherwise -> 'Mon D YYYY'
 */
export function formatWhen(epochMs: number, now: number = Date.now()): string {
  const d = new Date(epochMs)
  const n = new Date(now)

  if (isSameLocalDay(d, n)) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }

  const month = MONTH_ABBR[d.getMonth()]
  if (d.getFullYear() === n.getFullYear()) {
    return `${month} ${d.getDate()}`
  }
  return `${month} ${d.getDate()} ${d.getFullYear()}`
}

// ─── Outcome presentation ─────────────────────────────────────────────────────

/** Human label for an outcome result, or 'No outcome' when none was reported. */
export function resultLabel(result: OutcomeResult | null | undefined): string {
  switch (result) {
    case 'success':
      return 'Success'
    case 'partial':
      return 'Partial'
    case 'failure':
      return 'Failure'
    default:
      return 'No outcome'
  }
}
