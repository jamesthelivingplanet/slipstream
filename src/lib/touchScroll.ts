/**
 * touchScroll — pure gesture math for mobile PTY touch scrolling.
 *
 * xterm.js's own touch-pan scrolling is gated on
 * `!coreMouseService.areMouseEventsActive` — once the running TUI enables
 * mouse reporting (Claude Code does), a finger drag over the terminal does
 * nothing by default. Driving `term.scrollLines()` from raw touch events
 * doesn't fix this either: Claude Code runs in the alternate screen buffer
 * (`?1049h`), which has no scrollback, so `scrollLines()` is a no-op there
 * regardless of mouse tracking (TASK-A2FY6).
 *
 * Instead, `TouchScrollTracker` converts a pan into whole terminal lines,
 * and TerminalView dispatches one synthetic per-line `WheelEvent` on
 * `term.element` for each line — the same path xterm uses for desktop wheel
 * scrolling. xterm routes that wheel event exactly like real wheel input:
 * a mouse-wheel report to the PTY when the TUI has mouse tracking on, arrow
 * keys when in the alternate buffer without tracking, or a local viewport
 * scroll otherwise. `touchScrollRoute()` below decides which of those cases
 * applies so TerminalView knows whether to synthesize wheel events at all,
 * or leave xterm's own (still-live) touch handling alone.
 *
 * No DOM/xterm imports here — kept pure so it's cheap to unit test.
 */

/** Only samples within this many ms of the gesture end count toward release
 *  velocity — an old, stationary finger must not read as a flick. */
const VELOCITY_WINDOW_MS = 100

/** Exponential velocity decay rate (lines/ms lost per ms), tuned so a flick's
 *  momentum glides for roughly a second before crossing MOMENTUM_EPSILON. */
const MOMENTUM_DECAY_PER_MS = 0.004

/** Velocity (lines/ms) below which momentum is considered stopped. */
const MOMENTUM_EPSILON = 0.0003

/** Fallback cell height (px) when the terminal hasn't rendered a measurable
 *  row yet (e.g. before first paint). */
const DEFAULT_CELL_HEIGHT = 16

interface Sample {
  y: number
  t: number
}

/** Tracks an in-progress touch pan and converts it into whole terminal lines. */
export class TouchScrollTracker {
  private lastY = 0
  private remainder = 0
  private samples: Sample[] = []

  /** `cellHeight` returns the current px-per-row of the rendered terminal. */
  constructor(private cellHeight: () => number) {}

  private rowHeight(): number {
    const h = this.cellHeight()
    return h > 0 ? h : DEFAULT_CELL_HEIGHT
  }

  /** Begin a new pan: resets the fractional remainder and velocity samples. */
  start(y: number, timeMs: number): void {
    this.lastY = y
    this.remainder = 0
    this.samples = [{ y, t: timeMs }]
  }

  /** Record a pan move and return the whole number of lines to scroll now
   *  (positive = toward the bottom, i.e. finger moving up — matching native
   *  touch scrolling). Fractional pixels carry over to the next call. */
  move(y: number, timeMs: number): number {
    const deltaY = this.lastY - y // finger moving up (y decreasing) → positive
    this.lastY = y
    this.samples.push({ y, t: timeMs })
    // Keep a little more than the velocity window so end() always has
    // enough history, without the sample list growing unbounded.
    const cutoff = timeMs - VELOCITY_WINDOW_MS * 2
    while (this.samples.length > 1 && this.samples[0].t < cutoff) this.samples.shift()

    const total = this.remainder + deltaY / this.rowHeight()
    const lines = Math.trunc(total)
    this.remainder = total - lines
    return lines
  }

  /** Release velocity in lines per millisecond, using only samples from the
   *  last ~100ms — 0 if the gesture was slow/stationary at release. */
  end(timeMs: number): number {
    const cutoff = timeMs - VELOCITY_WINDOW_MS
    const recent = this.samples.filter((s) => s.t >= cutoff)
    if (recent.length < 2) return 0
    const first = recent[0]
    const last = recent[recent.length - 1]
    const dt = last.t - first.t
    if (dt <= 0) return 0
    const dy = first.y - last.y // finger moving up → positive
    return dy / this.rowHeight() / dt
  }
}

/** One momentum-glide animation frame: exponentially decays `velocity` over
 *  `dtMs`, returning the whole lines to scroll this frame (fractional part
 *  carried in `remainder`) and the decayed velocity for the next frame.
 *  Velocity below MOMENTUM_EPSILON is reported as fully stopped (0). */
export function momentumStep(
  velocity: number,
  dtMs: number,
  remainder: number,
): { lines: number; velocity: number; remainder: number } {
  if (dtMs <= 0 || Math.abs(velocity) < MOMENTUM_EPSILON) {
    return { lines: 0, velocity: 0, remainder }
  }
  const nextVelocity = velocity * Math.exp(-MOMENTUM_DECAY_PER_MS * dtMs)
  // Analytic distance travelled while velocity decays exponentially from
  // `velocity` to `nextVelocity` (integral of v0 * e^-kt over [0, dtMs]).
  const distance = (velocity - nextVelocity) / MOMENTUM_DECAY_PER_MS
  const total = remainder + distance
  const lines = Math.trunc(total)
  return {
    lines,
    velocity: Math.abs(nextVelocity) < MOMENTUM_EPSILON ? 0 : nextVelocity,
    remainder: total - lines,
  }
}

/** Where a touch pan should be routed.
 *  - 'wheel': synthesize per-line wheel events on xterm's root element —
 *    xterm turns them into mouse-wheel reports (mouse tracking on) or
 *    arrow keys (alternate buffer without tracking), same as desktop wheel.
 *  - 'native': do nothing; xterm's built-in touch-pan scrolling is live
 *    (normal buffer, no mouse tracking) and handles the gesture itself. */
export type TouchScrollRoute = 'wheel' | 'native'

export function touchScrollRoute(
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any',
  bufferType: 'normal' | 'alternate',
): TouchScrollRoute {
  return mouseTrackingMode !== 'none' || bufferType === 'alternate' ? 'wheel' : 'native'
}
