import { describe, it, expect } from 'vitest'
import { ReplayGate } from './replayGate.js'

describe('ReplayGate', () => {
  it('holds chunks until the snapshot resolves, then flushes duplicates dropped', () => {
    const sunk: string[] = []
    const gate = new ReplayGate((chunk) => sunk.push(chunk))

    gate.push('live-a', 10)
    gate.push('live-b', 20) // duplicate — already covered by the snapshot below
    expect(sunk).toEqual([]) // nothing sunk while closed

    gate.applySnapshot('snapshot', 15)

    // Snapshot written first, then only chunks newer than snap.seq (15).
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
})
