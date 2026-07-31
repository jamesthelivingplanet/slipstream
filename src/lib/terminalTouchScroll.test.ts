import { describe, it, expect, vi } from 'vitest'
import {
  TerminalTouchScroll,
  type TouchScrollHost,
  type ElementRect,
} from './terminalTouchScroll.js'

const CELL = 16
const RECT: ElementRect = { left: 0, right: 300, top: 0, bottom: 300 }

interface Dispatched {
  deltaY: 1 | -1
  clientX: number
  clientY: number
}

/** A fake host that runs rAF synchronously-on-demand (tests drive frames by
 *  calling `runFrame`) rather than actually scheduling — keeps momentum
 *  tests deterministic and fast. */
function fakeHost(overrides: Partial<TouchScrollHost> = {}) {
  const dispatched: Dispatched[] = []
  let destroyed = false
  let nowMs = 0
  let mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' = 'none'
  let bufferType: 'normal' | 'alternate' = 'alternate' // routes to 'wheel' by default
  let rect: ElementRect | null = RECT
  let pendingFrame: ((now: number) => void) | null = null
  let nextHandle = 1
  const cancelled: number[] = []

  const host: TouchScrollHost = {
    rows: () => 30,
    cellHeight: () => CELL,
    mouseTrackingMode: () => mouseTrackingMode,
    bufferType: () => bufferType,
    isDestroyed: () => destroyed,
    now: () => nowMs,
    requestFrame: (cb) => {
      pendingFrame = cb
      return nextHandle++
    },
    cancelFrame: (handle) => {
      cancelled.push(handle)
      pendingFrame = null
    },
    elementRect: () => rect,
    dispatchWheelLine: (deltaY, clientX, clientY) => {
      dispatched.push({ deltaY, clientX, clientY })
    },
    ...overrides,
  }

  return {
    host,
    dispatched,
    cancelled,
    setDestroyed: (v: boolean) => (destroyed = v),
    setNow: (v: number) => (nowMs = v),
    setMouseTrackingMode: (v: typeof mouseTrackingMode) => (mouseTrackingMode = v),
    setBufferType: (v: typeof bufferType) => (bufferType = v),
    setRect: (v: ElementRect | null) => (rect = v),
    /** Run the currently-scheduled rAF frame (if any) at time `t`. */
    runFrame: (t: number) => {
      const cb = pendingFrame
      pendingFrame = null
      cb?.(t)
    },
    hasPendingFrame: () => pendingFrame !== null,
  }
}

function touch(x: number, y: number, timeStamp: number) {
  return { touches: [{ clientX: x, clientY: y }], timeStamp, preventDefault: vi.fn() }
}

function multiTouch(timeStamp: number) {
  return {
    touches: [
      { clientX: 0, clientY: 0 },
      { clientX: 1, clientY: 1 },
    ],
    timeStamp,
    preventDefault: vi.fn(),
  }
}

describe('TerminalTouchScroll', () => {
  it('a touch-move pan dispatches synthetic wheel lines and preventDefaults', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 200, 0))
    const move = touch(50, 200 - CELL * 3, 50) // finger up 3 cells → 3 lines toward bottom
    ts.onTouchMove(move)
    expect(f.dispatched.length).toBe(3)
    expect(f.dispatched.every((d) => d.deltaY === 1)).toBe(true)
    expect(move.preventDefault).toHaveBeenCalled()
  })

  it('ignores touch-move when the route is native (normal buffer, no mouse tracking)', () => {
    const f = fakeHost()
    f.setBufferType('normal')
    f.setMouseTrackingMode('none')
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 200, 0))
    const move = touch(50, 100, 50)
    ts.onTouchMove(move)
    expect(f.dispatched.length).toBe(0)
    expect(move.preventDefault).not.toHaveBeenCalled()
  })

  it('clamps dispatched coordinates into the element rect', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    // Start far outside the rect (rect is 0..300).
    ts.onTouchStart(touch(-50, -50, 0))
    ts.onTouchMove(touch(-50, -50 - CELL, 50))
    expect(f.dispatched[0].clientX).toBe(RECT.left + 1)
    expect(f.dispatched[0].clientY).toBe(RECT.top + 1)
  })

  it('does nothing when there is no element rect yet', () => {
    const f = fakeHost()
    f.setRect(null)
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 200, 0))
    ts.onTouchMove(touch(50, 200 - CELL * 2, 50))
    expect(f.dispatched.length).toBe(0)
  })

  it('a second touch during a move ends the gesture instead of panning it', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 200, 0))
    ts.onTouchMove(touch(50, 190, 10))
    const before = f.dispatched.length
    ts.onTouchMove(multiTouch(20))
    // onTouchEnd was invoked instead of a pan — no additional wheel-line
    // dispatch happens synchronously from onTouchEnd itself (only from a
    // momentum frame, which onTouchEnd may schedule).
    expect(f.dispatched.length).toBe(before)
  })

  it('a flick at release schedules a momentum glide that decays to a stop', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    f.setNow(0)
    ts.onTouchStart(touch(50, 500, 0))
    ts.onTouchMove(touch(50, 400, 20))
    ts.onTouchMove(touch(50, 300, 40)) // fast upward flick
    ts.onTouchEnd(touch(50, 300, 50))
    expect(f.hasPendingFrame()).toBe(true)

    // Drive frames until momentum naturally stops (bounded to avoid an
    // infinite loop if the decay logic regresses).
    let t = 60
    let frames = 0
    while (f.hasPendingFrame() && frames < 500) {
      t += 16
      f.runFrame(t)
      frames++
    }
    expect(frames).toBeGreaterThan(0)
    expect(f.hasPendingFrame()).toBe(false)
  })

  it('a momentum frame bails without dispatching once the host reports destroyed', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 500, 0))
    ts.onTouchMove(touch(50, 400, 20))
    ts.onTouchMove(touch(50, 300, 40))
    ts.onTouchEnd(touch(50, 300, 50))
    expect(f.hasPendingFrame()).toBe(true)

    const dispatchedBefore = f.dispatched.length
    f.setDestroyed(true)
    f.runFrame(100)
    expect(f.hasPendingFrame()).toBe(false)
    expect(f.dispatched.length).toBe(dispatchedBefore)
  })

  it('onTouchCancel stops an in-flight momentum glide', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 500, 0))
    ts.onTouchMove(touch(50, 400, 20))
    ts.onTouchMove(touch(50, 300, 40))
    ts.onTouchEnd(touch(50, 300, 50))
    expect(f.hasPendingFrame()).toBe(true)

    ts.onTouchCancel()
    expect(f.hasPendingFrame()).toBe(false)
    expect(f.cancelled.length).toBe(1)
  })

  it('a new touch-start cancels any prior momentum glide', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 500, 0))
    ts.onTouchMove(touch(50, 400, 20))
    ts.onTouchMove(touch(50, 300, 40))
    ts.onTouchEnd(touch(50, 300, 50))
    expect(f.hasPendingFrame()).toBe(true)

    ts.onTouchStart(touch(10, 10, 60))
    expect(f.hasPendingFrame()).toBe(false)
  })

  it('a slow release (no flick) does not schedule momentum', () => {
    const f = fakeHost()
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 500, 0))
    ts.onTouchMove(touch(50, 495, 10))
    // Long pause before release — end() reports 0 velocity per touchScroll's
    // VELOCITY_WINDOW_MS cutoff.
    ts.onTouchEnd(touch(50, 495, 1000))
    expect(f.hasPendingFrame()).toBe(false)
  })

  it('onTouchEnd on the native route does not schedule momentum even after a flick', () => {
    const f = fakeHost()
    f.setBufferType('normal')
    f.setMouseTrackingMode('none')
    const ts = new TerminalTouchScroll(f.host)
    ts.onTouchStart(touch(50, 500, 0))
    ts.onTouchEnd(touch(50, 300, 50))
    expect(f.hasPendingFrame()).toBe(false)
  })
})
