import { describe, it, expect } from 'vitest'
import { ReplayGate } from './replayGate.js'

describe('ReplayGate', () => {
  it('holds chunks until the snapshot resolves, then flushes only chunks newer than it', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    // seq is a cumulative character count (see OutputBuffer.push): 'live-a'
    // (6 chars) is the first chunk ever pushed, ending at seq 6; 'live-b' (6
    // chars) immediately follows, ending at seq 12 — so it starts exactly at
    // the seq-6 snapshot boundary below (no straddle; see the dedicated
    // straddling-batch tests further down for that case).
    gate.push('live-a', 6) // fully covered by the snapshot — dropped
    gate.push('live-b', 12) // entirely newer than the snapshot — kept whole
    expect(sunk).toEqual([]) // nothing sunk while closed

    gate.applySnapshot('snapshot', 6)

    expect(sunk).toEqual(['snapshot', 'live-b'])
  })

  it('passes chunks straight through once open', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))
    gate.applySnapshot('snapshot', 0)
    expect(gate.open).toBe(true)

    gate.push('after-1', 1)
    gate.push('after-2', 2)
    expect(sunk).toEqual(['snapshot', 'after-1', 'after-2'])
  })

  it('an empty pre-first-output snapshot (data "", seq 0) opens the gate', () => {
    // Regression: a snapshot fetched before the agent's first frame — the
    // common fresh-start case — must not leave the gate wedged closed.
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.applySnapshot('', 0)
    expect(gate.open).toBe(true)

    gate.push('first frame', 11)
    expect(sunk).toEqual(['', 'first frame'])
  })

  it('clamps a negative snapshot seq so the gate still opens', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.applySnapshot('', -1)
    expect(gate.open).toBe(true)

    gate.push('live', 1)
    expect(sunk).toEqual(['', 'live'])
  })

  it('fail() flushes everything held and opens the gate for subsequent chunks', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.push('held-1', 1)
    gate.push('held-2', 2)
    expect(sunk).toEqual([])

    gate.fail()
    expect(sunk).toEqual(['held-1', 'held-2'])
    expect(gate.open).toBe(true)

    gate.push('live-after-fail', 3)
    expect(sunk).toEqual(['held-1', 'held-2', 'live-after-fail'])
  })

  it('applySnapshot writes snapshot data before any held chunks', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.push('held', 5)
    gate.applySnapshot('snap', 0)

    expect(sunk[0]).toBe('snap')
    expect(sunk[1]).toBe('held')
  })

  it('applySnapshot is a no-op once already open', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.fail()
    gate.applySnapshot('should-not-appear', 100)
    expect(sunk).toEqual([])
  })

  it('fail() is a no-op once already open', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.applySnapshot('snap', 0)
    gate.push('held-after-open', 1)
    gate.fail() // should not re-flush or re-open

    expect(sunk).toEqual(['snap', 'held-after-open'])
  })

  describe('straddling batches (FLO-103 reconnect resync)', () => {
    // The server coalesces PTY chunks into 40ms batches and stamps each
    // pushed batch with the LAST chunk's cumulative seq (seq = end of the
    // batch, not its start — see electron/services/outputBuffer.ts). A batch
    // can straddle the snapshot boundary: start before the snapshot's seq,
    // end after it. Only the bytes past the boundary are new.

    it('a batch fully BEFORE the snapshot seq is dropped entirely', () => {
      const sunk: string[] = []
      const gate = new ReplayGate((chunk) => sunk.push(chunk))

      // 'held' is 4 chars, ending at cumulative seq 10 (so it spans [6, 10)).
      gate.push('held', 10)
      gate.applySnapshot('snap', 20) // snapshot already covers past seq 10

      expect(sunk).toEqual(['snap'])
    })

    it('a batch fully AFTER the snapshot seq is written whole', () => {
      const sunk: string[] = []
      const gate = new ReplayGate((chunk) => sunk.push(chunk))

      // 'held' spans [10, 14) — starts at/after the snapshot's seq of 10.
      gate.push('held', 14)
      gate.applySnapshot('snap', 10)

      expect(sunk).toEqual(['snap', 'held'])
    })

    it('a batch straddling the snapshot seq is sliced to only the new tail', () => {
      const sunk: string[] = []
      const gate = new ReplayGate((chunk) => sunk.push(chunk))

      // 'abcdefghij' is 10 chars ending at cumulative seq 30, so it spans
      // [20, 30). A snapshot at seq 25 covers [20, 25) of it — only the last
      // 5 chars ('fghij') are new.
      gate.push('abcdefghij', 30)
      gate.applySnapshot('snap', 25)

      expect(sunk).toEqual(['snap', 'fghij'])
    })
  })
})
