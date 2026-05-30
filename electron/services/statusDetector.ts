/**
 * StatusDetector — classifies a PTY agent's live state from its output stream.
 *
 * Design goals:
 *   - Pure / side-effect-free: no timers. The caller supplies `now()`.
 *   - Fully unit-testable by feeding chunks and a fake clock.
 *   - Heuristics are intentionally coarse; tighten over time.
 */

import type { IStatusDetector, SessionStatus } from '../shared/contract.js'

// ─── ANSI stripping ─────────────────────────────────────────────────────────

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/** Strip ANSI/VT escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// ─── "Awaiting input" patterns ───────────────────────────────────────────────

/**
 * Each regex is tested against the trimmed tail of the recent output buffer
 * (after ANSI stripping). A match means the agent appears to be waiting for
 * user input.
 */
export const NEEDS_PATTERNS: RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\(y\/N\)/,
  /\[Y\/n\]/,
  /Should I\b/i,
  /Do you want\b/i,
  /Continue\?/i,
  /Proceed\?/i,
  /Press enter/i,
  /\?\s*$/,       // ends with a question mark (optionally trailing whitespace)
  /[❯>]\s*$/,     // trailing prompt glyph
]

/**
 * Returns true when `tail` (trimmed, ANSI-stripped) matches any NEEDS_PATTERN.
 * Pure helper — exported so tests can exercise it directly.
 */
export function looksLikeQuestion(tail: string): boolean {
  const t = stripAnsi(tail).trim()
  return NEEDS_PATTERNS.some(re => re.test(t))
}

// ─── Buffer constants ────────────────────────────────────────────────────────

const MAX_BUFFER = 4096  // ~4 KB of recent output retained

// ─── StatusDetector ──────────────────────────────────────────────────────────

export interface StatusDetectorOptions {
  /** Milliseconds of output silence before we inspect for "needs" vs idle. */
  idleMs?: number
  /** Injectable clock; defaults to Date.now. */
  now?: () => number
}

export class StatusDetector implements IStatusDetector {
  private readonly idleMs: number
  private readonly now: () => number

  // Rolling buffer of recent output (bounded to MAX_BUFFER chars)
  private buffer = ''

  private lastOutputAt: number
  private exited = false
  private exitCode: number | null = null

  constructor(opts: StatusDetectorOptions = {}) {
    this.idleMs = opts.idleMs ?? 4000
    this.now = opts.now ?? Date.now
    this.lastOutputAt = this.now()
  }

  /** Append a PTY data chunk; keeps only the last MAX_BUFFER characters. */
  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER)
    }
    this.lastOutputAt = this.now()
  }

  /** Record process exit; subsequent status() calls return 'done' or 'errored'. */
  markExit(code: number): void {
    this.exited = true
    this.exitCode = code
  }

  /** Best-guess status given all data pushed so far plus the current time. */
  status(): SessionStatus {
    if (this.exited) {
      return this.exitCode === 0 ? 'done' : 'errored'
    }

    const elapsed = this.now() - this.lastOutputAt
    if (elapsed < this.idleMs) {
      // Output is still flowing; don't bother inspecting content yet.
      return 'running'
    }

    // Output has gone quiet — inspect the tail for interactive prompts.
    const tail = this.buffer.slice(-512) // last 512 chars is plenty for a prompt
    return looksLikeQuestion(tail) ? 'needs' : 'running'
  }
}
