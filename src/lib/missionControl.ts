/**
 * Mission Control — pure helpers for the home view.
 *
 * These mirror the heuristics in `electron/services/statusDetector.ts` (the
 * backend's 'needs' classifier) so the UI surfaces the same trailing question
 * the detector keyed on, plus small presentation helpers (elapsed-time
 * formatting) and the other pure glue extracted from MissionControl.svelte
 * (PR status chips, usage/cost rollup, ask-fetch cache targeting).
 */

import type { PrStatusDTO, SessionUsage, UsageSummary } from '../../electron/shared/contract.js'
import { formatCost, formatTokens, dayKeyFromMs } from '../../electron/shared/usageFormat.js'
import type { Session } from './types'

// ─── ANSI stripping ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- intentionally matches the ESC control char to strip ANSI/VT escapes
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/** Strip ANSI/VT escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// ─── "Question-like" line detection ─────────────────────────────────────────
// Mirrors the intent of statusDetector's NEEDS_PATTERNS, applied per-line so
// we can pick out the trailing block that constitutes the actual question.

function isQuestionLike(line: string): boolean {
  return (
    /\?\s*$/.test(line) ||
    /\(y\/n\)/i.test(line) ||
    /\[y\/n\]/i.test(line) ||
    /\[Y\/n\]/.test(line) ||
    /\(y\/N\)/.test(line) ||
    /:\s*$/.test(line)
  )
}

function isMenuOption(line: string): boolean {
  return /^\d+[.)]\s*/.test(line)
}

const DEFAULT_MAX_LEN = 160

/**
 * Given a session's raw PTY buffer (may be large; only the tail matters),
 * strip ANSI and pull out the trailing "question" the agent appears to be
 * asking the user — or null if the tail doesn't look like a question.
 */
export function extractAsk(buffer: string, maxLen: number = DEFAULT_MAX_LEN): string | null {
  if (!buffer || !buffer.trim()) return null

  const tail = stripAnsi(buffer.slice(-2000))
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) return null

  const last = lines[lines.length - 1]
  let block: string[]

  if (isMenuOption(last)) {
    // Walk backward over the contiguous run of numbered options to find the
    // question that introduced the menu.
    let i = lines.length - 1
    while (i >= 0 && isMenuOption(lines[i])) i--
    if (i >= 0 && isQuestionLike(lines[i])) {
      block = lines.slice(i)
    } else {
      return null
    }
  } else if (isQuestionLike(last)) {
    block = [last]
  } else {
    return null
  }

  const joined = block.join(' ').replace(/\s+/g, ' ').trim()
  if (!joined) return null

  if (joined.length > maxLen) {
    return joined.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…'
  }
  return joined
}

// ─── Suggested one-tap replies ──────────────────────────────────────────────
// Deliberately narrow: only the clearest yes/no-shaped asks get a reply chip.
// A chip that doesn't actually fit the question is worse than no chip at all,
// so anything ambiguous — multi-choice, open-ended, "which option" — falls
// through to []. Mirrors extractAsk's precedent of matching heuristics, not
// full NLP.

// Trailing "(y/n)", "[y/n]", "y/n?", "yes/no?" etc. — a slash-separated
// yes/no token pair, optionally bracketed, optionally followed by '?'.
const YN_RE = /[([]?\s*(y(?:es)?)\s*\/\s*(n(?:o)?)\s*[)\]]?\s*\??\s*$/i

// A trailing "proceed?" / "continue?" question, or the common phrasing
// "shall I proceed" (with or without a trailing '?').
const PROCEED_RE = /\b(?:proceed|continue)\s*\?\s*$/i
const SHALL_PROCEED_RE = /\bshall i proceed\b/i

/**
 * Given the ask text extracted by `extractAsk`, return 0-2 one-tap reply
 * strings for the common, unambiguous yes/no / proceed-or-stop question
 * shapes. Returns `[]` for anything else — including null/undefined/empty
 * input, and any open-ended or multi-choice ask. Never throws.
 */
export function suggestedReplies(ask: string | null | undefined): string[] {
  try {
    if (!ask || typeof ask !== 'string') return []
    const trimmed = ask.trim()
    if (!trimmed) return []

    const ynMatch = trimmed.match(YN_RE)
    if (ynMatch) {
      const yToken = ynMatch[1]
      const nToken = ynMatch[2]
      // Preserve the classic "(Y/n)" / "(y/N)" default-hint casing when
      // exactly one side is capitalized; otherwise default to lowercase.
      const yUpper = /^[A-Z]/.test(yToken)
      const nUpper = /^[A-Z]/.test(nToken)
      if (yUpper && !nUpper) return ['Y', 'n']
      if (nUpper && !yUpper) return ['y', 'N']
      return ['y', 'n']
    }

    if (PROCEED_RE.test(trimmed) || SHALL_PROCEED_RE.test(trimmed)) {
      return ['Yes', 'No']
    }

    return []
  } catch {
    return []
  }
}

// ─── Elapsed-time formatting ─────────────────────────────────────────────────

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Human-compact elapsed time since `sinceEpochMs`: '<1m' under a minute,
 * then 'Nm', then 'Nh Nm' under a day, then 'Nd'.
 */
export function formatWait(sinceEpochMs: number, nowEpochMs: number = Date.now()): string {
  const elapsed = Math.max(0, nowEpochMs - sinceEpochMs)

  if (elapsed < MINUTE_MS) return '<1m'

  if (elapsed < HOUR_MS) {
    const m = Math.floor(elapsed / MINUTE_MS)
    return `${m}m`
  }

  if (elapsed < DAY_MS) {
    const h = Math.floor(elapsed / HOUR_MS)
    const m = Math.floor((elapsed % HOUR_MS) / MINUTE_MS)
    return `${h}h ${m}m`
  }

  const d = Math.floor(elapsed / DAY_MS)
  return `${d}d`
}

// ─── PR/CI status chips (FLO-96) ───────────────────────────────────────────

export interface PrChip {
  text: string
  cls: 'done' | 'error' | 'needs' | 'muted'
}

/** Compact chip list for a session's PR: merge state, CI, review — in that
 *  order, omitting states that aren't worth a chip (none/unknown CI,
 *  none/unknown review). An error collapses to a single "PR ?" chip. */
export function prChips(dto: PrStatusDTO | undefined): PrChip[] {
  if (!dto) return []
  if (dto.error) return [{ text: 'PR ?', cls: 'muted' }]
  const chips: PrChip[] = []
  if (dto.state === 'merged') chips.push({ text: 'merged', cls: 'done' })
  else if (dto.state === 'open') chips.push({ text: 'open', cls: 'muted' })
  else if (dto.state === 'closed') chips.push({ text: 'closed', cls: 'error' })
  if (dto.ci === 'passed') chips.push({ text: 'CI ✓', cls: 'done' })
  else if (dto.ci === 'failed') chips.push({ text: 'CI ✗', cls: 'error' })
  else if (dto.ci === 'pending' || dto.ci === 'running') chips.push({ text: 'CI …', cls: 'needs' })
  if (dto.review === 'approved') chips.push({ text: 'approved', cls: 'done' })
  else if (dto.review === 'changes_requested') chips.push({ text: 'changes', cls: 'error' })
  return chips
}

/** A done session whose PR is known but hasn't merged yet needs to read
 *  differently from one that actually landed. */
export function prNotMerged(dto: PrStatusDTO | undefined): boolean {
  return !!dto && dto.state !== 'unknown' && dto.state !== 'merged'
}

// ─── Usage/cost rollup (FLO-94) ─────────────────────────────────────────────

/** Rolls the raw UsageSummary into the three derived values Mission Control's
 *  header/rows read: a by-session lookup map, today's spend, and whether
 *  there's any spend at all worth surfacing. */
export function computeUsageRollup(
  usage: UsageSummary | null,
  nowMs: number = Date.now(),
): { usageById: Map<string, SessionUsage>; todayCost: number; hasUsage: boolean } {
  const usageById = new Map<string, SessionUsage>(
    (usage?.sessions ?? []).map((s) => [s.sessionId, s]),
  )
  const todayCost = usage?.byDay.find((b) => b.key === dayKeyFromMs(nowMs))?.costUsd ?? 0
  const hasUsage = (usage?.costUsd ?? 0) > 0
  return { usageById, todayCost, hasUsage }
}

/** Cost chip text for a session row, or null when there's no usage yet. */
export function costFor(u: SessionUsage | undefined): { cost: string; tokens: string } | null {
  if (!u || !u.exists || u.turns === 0) return null
  const tokens = u.tokens.input + u.tokens.output + u.tokens.cacheCreation + u.tokens.cacheRead
  return { cost: formatCost(u.costUsd), tokens: formatTokens(tokens) }
}

// ─── Session relationships (TASK-CIOEQ) ─────────────────────────────────────

/** Title of the session that spawned `parentId` via `slipstream new-agent`,
 *  or undefined when there's no parentId or the parent isn't (or is no
 *  longer) a known session. */
export function findParentTitle(
  sessions: Session[],
  parentId: string | undefined,
): string | undefined {
  if (!parentId) return undefined
  return sessions.find((x) => x.id === parentId)?.title
}

/** How many currently-known sessions were spawned by `sessionId` via
 *  `slipstream new-agent`. */
export function countSpawned(sessions: Session[], sessionId: string | undefined): number {
  if (!sessionId) return 0
  return sessions.filter((x) => x.parentId === sessionId).length
}

// ─── Ask-extraction fetch cache (load-bearing — see docs/ARCHITECTURE.md
// §Session status pipeline) ─────────────────────────────────────────────────
//
// The `status` event fires on EVERY PTY chunk, and the heuristic status
// flaps 'needs'↔'running' every few seconds by design on an idle TUI. These
// two functions decide, given the current session list and the set of ids
// already fetched, which ids are a NEW entry into 'needs' (fetch once) and
// which previously-fetched ids have left 'needs' (clear so a future
// re-entry fetches again) — the guard that keeps refreshAsks from turning
// into a per-tick fetch.

/** Session ids that just entered 'needs' and haven't been fetched yet. */
export function sessionsNeedingAskFetch(
  list: Session[],
  fetchedFor: ReadonlySet<string>,
): string[] {
  const ids: string[] = []
  for (const s of list) {
    if (s.status === 'needs' && s.id && !fetchedFor.has(s.id)) ids.push(s.id)
  }
  return ids
}

/** Previously-fetched ids whose session has left 'needs' (or disappeared),
 *  so the cache entry can be cleared and re-fetched on a future re-entry. */
export function staleAskFetchIds(list: Session[], fetchedFor: ReadonlySet<string>): string[] {
  const stale: string[] = []
  for (const id of fetchedFor) {
    const s = list.find((x) => x.id === id)
    if (!s || s.status !== 'needs') stale.push(id)
  }
  return stale
}

// ─── FLO-152 swipe-row identity/toggle helpers ──────────────────────────────

/** Stable key for a session's swipe row: backend id when present, else the
 *  ticket id (mock/pre-registration sessions have no backend id yet). */
export function sessionSwipeKey(s: Session): string {
  return s.id ?? s.tid
}

/** Toggle semantics for the single shared "which row's handoff menu is
 *  open" value: selecting the already-open row's key closes it. */
export function nextHandoffFor(current: string | null, key: string): string | null {
  return current === key ? null : key
}
