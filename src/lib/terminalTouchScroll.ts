/**
 * TerminalTouchScroll — DOM-facing orchestration around the pure gesture math
 * in touchScroll.ts. Owns one xterm mount's touch state (the
 * TouchScrollTracker plus any in-flight momentum glide) and turns a touch
 * pan/flick into synthetic per-line "wheel" dispatches — see touchScroll.ts's
 * module doc for why xterm needs those instead of scrollLines()/native touch
 * handling.
 *
 * Every DOM/timing primitive (rAF, performance.now, the wheel dispatch
 * itself, the element's bounding rect) is injected via `TouchScrollHost`
 * rather than referenced globally, so the sequencing here — which callback
 * runs when, in what order, and when a frame bails on teardown — is unit
 * testable under vitest's `node` environment with a fake host. Mirrors the
 * ImageUploadDeps DI convention in imageUpload.ts.
 */
import { TouchScrollTracker, momentumStep, touchScrollRoute } from './touchScroll.js'

export interface ElementRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface TouchScrollHost {
  /** Current terminal row count — clamps how many synthetic wheel lines a
   *  single touch-move/momentum frame may dispatch at once. */
  rows: () => number
  /** Rendered px-per-row; TouchScrollTracker falls back internally if <= 0. */
  cellHeight: () => number
  mouseTrackingMode: () => 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  bufferType: () => 'normal' | 'alternate'
  /** True once the owning component has started tearing down — an in-flight
   *  momentum animation frame checks this and bails rather than touching a
   *  disposed terminal. */
  isDestroyed: () => boolean
  now: () => number
  requestFrame: (cb: (now: number) => void) => number
  cancelFrame: (handle: number) => void
  /** xterm's root element's bounding box, or null before it exists — used
   *  only to clamp synthetic coordinates into the terminal's own box. */
  elementRect: () => ElementRect | null
  /** Dispatch one synthetic per-line wheel event at the given (already
   *  clamped) coordinates. */
  dispatchWheelLine: (deltaY: 1 | -1, clientX: number, clientY: number) => void
}

/** Minimal shape TerminalTouchScroll needs from a TouchEvent — matches the
 *  DOM type structurally so real TouchEvents pass through untouched, while
 *  tests can hand in a plain object. */
export interface TouchEventLike {
  touches: ArrayLike<{ clientX: number; clientY: number }>
  timeStamp: number
  preventDefault: () => void
}

export class TerminalTouchScroll {
  private tracker: TouchScrollTracker
  private momentumHandle: number | null = null
  private lastX = 0
  private lastY = 0

  constructor(private host: TouchScrollHost) {
    this.tracker = new TouchScrollTracker(() => host.cellHeight())
  }

  private routesToWheel(): boolean {
    return touchScrollRoute(this.host.mouseTrackingMode(), this.host.bufferType()) === 'wheel'
  }

  private dispatchLines(lines: number): void {
    if (lines === 0) return
    const rect = this.host.elementRect()
    if (!rect) return
    // Clamp to the terminal's box — a captured touch can wander outside it,
    // and xterm drops reports whose coordinates fall off the screen.
    const x = Math.min(Math.max(this.lastX, rect.left + 1), rect.right - 1)
    const y = Math.min(Math.max(this.lastY, rect.top + 1), rect.bottom - 1)
    const deltaY = lines > 0 ? 1 : -1
    const count = Math.min(Math.abs(lines), this.host.rows())
    for (let i = 0; i < count; i++) {
      this.host.dispatchWheelLine(deltaY, x, y)
    }
  }

  /** Cancel any in-flight momentum glide (e.g. on a new touch, teardown, or
   *  switching sessions). Safe to call when nothing is running. */
  stopMomentum(): void {
    if (this.momentumHandle !== null) {
      this.host.cancelFrame(this.momentumHandle)
      this.momentumHandle = null
    }
  }

  private runMomentum(velocity: number): void {
    this.stopMomentum()
    let v = velocity
    let remainder = 0
    let last = this.host.now()
    const frame = (now: number) => {
      // Guard against the terminal being disposed mid-glide.
      if (this.host.isDestroyed()) {
        this.momentumHandle = null
        return
      }
      const dt = now - last
      last = now
      const step = momentumStep(v, dt, remainder)
      v = step.velocity
      remainder = step.remainder
      this.dispatchLines(step.lines)
      if (v === 0) {
        this.momentumHandle = null
        return
      }
      this.momentumHandle = this.host.requestFrame(frame)
    }
    this.momentumHandle = this.host.requestFrame(frame)
  }

  onTouchStart(e: TouchEventLike): void {
    this.stopMomentum()
    if (e.touches.length > 1) return
    this.lastX = e.touches[0].clientX
    this.lastY = e.touches[0].clientY
    this.tracker.start(e.touches[0].clientY, e.timeStamp)
  }

  onTouchMove(e: TouchEventLike): void {
    if (e.touches.length > 1) {
      this.onTouchEnd(e)
      return
    }
    if (!this.routesToWheel()) return
    this.lastX = e.touches[0].clientX
    this.lastY = e.touches[0].clientY
    const lines = this.tracker.move(e.touches[0].clientY, e.timeStamp)
    this.dispatchLines(lines)
    e.preventDefault()
  }

  onTouchEnd(e: TouchEventLike): void {
    if (!this.routesToWheel()) return
    const velocity = this.tracker.end(e.timeStamp)
    if (velocity !== 0) this.runMomentum(velocity)
  }

  onTouchCancel(): void {
    this.stopMomentum()
  }
}
