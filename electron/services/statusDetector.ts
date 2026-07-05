/**
 * StatusDetector — classifies a PTY agent's live state from its output stream.
 *
 * Design goals:
 *   - Pure / side-effect-free: no timers. The caller supplies `now()`.
 *   - Fully unit-testable by feeding chunks and a fake clock.
 *   - Heuristics are intentionally coarse; tighten over time.
 */

import type { IStatusDetector, SessionStatus } from '../shared/contract.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

// ─── ANSI stripping ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- intentionally matches the ESC control char to strip ANSI/VT escapes
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
  /Would you like\b/i,
  /\bpress\s+(enter|return|any key)\b/i,
  /❯\s*\d+[.)]/, // arrow pointing at a numbered menu option (e.g. permission select box)
  /\?\s*$/, // ends with a question mark (optionally trailing whitespace)
  /[❯>]\s*$/, // trailing prompt glyph
]

/**
 * Returns true when `tail` (trimmed, ANSI-stripped) matches any NEEDS_PATTERN.
 * Pure helper — exported so tests can exercise it directly.
 */
export function looksLikeQuestion(tail: string): boolean {
  const t = stripAnsi(tail).trim()
  return NEEDS_PATTERNS.some((re) => re.test(t))
}

/**
 * Inspect the (ANSI-stripped) tail for an explicit state marker emitted by the
 * agent. The LAST marker in the tail is the one that wins — this lets the agent
 * transition between states within a single turn. A marker only counts when
 * nothing alphanumeric follows it (trailing whitespace, box-draw chars, or a
 * prompt glyph are fine).
 *
 * Returns 'needs' | 'done' | 'running' for a trailing marker, or null otherwise.
 */
export function tailSignal(tail: string): 'needs' | 'done' | 'running' | null {
  const t = stripAnsi(tail)
  const candidates: [string, 'needs' | 'done' | 'running'][] = [
    [NEEDS_INPUT_MARKER, 'needs'],
    [DONE_MARKER, 'done'],
    [IN_PROGRESS_MARKER, 'running'],
  ]
  // Find which marker appears last in the tail
  let bestIdx = -1
  let bestStatus: 'needs' | 'done' | 'running' | null = null
  for (const [marker, status] of candidates) {
    const idx = t.lastIndexOf(marker)
    if (idx === -1) continue
    if (idx > bestIdx) {
      bestIdx = idx
      bestStatus = status
    }
  }
  if (bestIdx === -1 || bestStatus === null) return null
  // Find the marker string for the best candidate
  const bestMarker = candidates.find(([, s]) => s === bestStatus)![0]
  const after = t.slice(bestIdx + bestMarker.length)
  if (!/[A-Za-z0-9]/.test(after)) return bestStatus
  return null
}

// ─── Buffer constants ────────────────────────────────────────────────────────

const MAX_BUFFER = 4096 // ~4 KB of recent output retained

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
  private lastMarkerAt = 0
  private exited = false
  private exitCode: number | null = null

  // Out-of-band signal reported via the app MCP's report_status tool.
  private signalState: 'needs' | 'done' | 'running' | null = null
  private signalAt = 0

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
    if (tailSignal(this.buffer.slice(-512))) {
      this.lastMarkerAt = this.now()
    }
  }

  /** Record process exit; subsequent status() calls return 'done' or 'errored'. */
  markExit(code: number): void {
    this.exited = true
    this.exitCode = code
  }

  /**
   * Apply an out-of-band status signal reported via the app MCP's
   * `report_status` tool. This is the reliable channel: it doesn't depend on
   * scraping PTY output. `done` is sticky (see status()); `needs`/`running`
   * are overridden only by a strictly-newer PTY marker or a process exit.
   */
  applySignal(state: 'needs' | 'done' | 'running', at?: number): void {
    this.signalState = state
    this.signalAt = at ?? this.now()
  }

  /** Best-guess status given all data pushed so far plus the current time. */
  status(): SessionStatus {
    if (this.exited) {
      return this.exitCode === 0 ? 'done' : 'errored'
    }

    // MCP "done" is sticky — once the agent reports completion, nothing short
    // of a real process exit should undo it.
    if (this.signalState === 'done') return 'done'

    const tail = this.buffer.slice(-512)
    const marker = tailSignal(tail)

    // An explicit MCP signal is a deliberate declaration; like `done` it stays in
    // effect until a strictly-newer explicit tail marker (or process exit)
    // supersedes it — ordinary non-marker output must not revert it.
    if (this.signalState && this.signalAt >= this.lastMarkerAt) return this.signalState
    if (marker) return marker

    const elapsed = this.now() - this.lastOutputAt
    if (elapsed < this.idleMs) {
      // Output is still flowing; don't bother inspecting content yet.
      return 'running'
    }

    // Output has gone quiet — fall back to coarse interactive-prompt heuristics.
    return looksLikeQuestion(tail) ? 'needs' : 'running'
  }
}
