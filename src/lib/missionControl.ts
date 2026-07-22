/**
 * Mission Control — pure helpers for the home view.
 *
 * These mirror the heuristics in `electron/services/statusDetector.ts` (the
 * backend's 'needs' classifier) so the UI surfaces the same trailing question
 * the detector keyed on, plus small presentation helpers (elapsed-time
 * formatting).
 */

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
