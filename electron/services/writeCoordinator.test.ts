import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWriteCoordinator } from './writeCoordinator.js'
import type { IWriteCoordinator } from './writeCoordinator.js'

describe('createWriteCoordinator', () => {
  let coord: IWriteCoordinator

  beforeEach(() => {
    coord = createWriteCoordinator()
  })

  it('grants the write lock to the first client that attaches', () => {
    coord.attach('s1', 'a')
    expect(coord.canWrite('s1', 'a')).toBe(true)
  })

  it('makes a second attaching client view-only', () => {
    coord.attach('s1', 'a')
    coord.attach('s1', 'b')
    expect(coord.canWrite('s1', 'a')).toBe(true)
    expect(coord.canWrite('s1', 'b')).toBe(false)
  })

  it('counts viewers', () => {
    coord.attach('s1', 'a')
    coord.attach('s1', 'b')
    coord.attach('s1', 'c')
    expect(coord.viewers('s1')).toBe(3)
    expect(coord.viewers('unknown')).toBe(0)
  })

  it('isViewer reflects attachment', () => {
    coord.attach('s1', 'a')
    expect(coord.isViewer('s1', 'a')).toBe(true)
    expect(coord.isViewer('s1', 'b')).toBe(false)
  })

  it('take transfers the lock and fires change', () => {
    coord.attach('s1', 'a')
    coord.attach('s1', 'b')
    const listener = vi.fn()
    coord.on('change', listener)

    coord.take('s1', 'b')

    expect(coord.canWrite('s1', 'a')).toBe(false)
    expect(coord.canWrite('s1', 'b')).toBe(true)
    expect(listener).toHaveBeenCalledWith('s1')
  })

  it('take adds a non-viewer as a viewer and grants the lock', () => {
    coord.attach('s1', 'a')
    coord.take('s1', 'c')
    expect(coord.isViewer('s1', 'c')).toBe(true)
    expect(coord.canWrite('s1', 'c')).toBe(true)
    expect(coord.viewers('s1')).toBe(2)
  })

  it('detach of the holder reassigns to a remaining viewer', () => {
    coord.attach('s1', 'a')
    coord.attach('s1', 'b')
    coord.detach('s1', 'a')
    expect(coord.canWrite('s1', 'b')).toBe(true)
    expect(coord.viewers('s1')).toBe(1)
  })

  it('detach of the last viewer frees the lock and zeroes viewers', () => {
    coord.attach('s1', 'a')
    coord.detach('s1', 'a')
    expect(coord.viewers('s1')).toBe(0)
    expect(coord.canWrite('s1', 'a')).toBe(false)
  })

  it('noteWrite auto-claims a free lock', () => {
    expect(coord.noteWrite('s1', 'a')).toBe(true)
    expect(coord.canWrite('s1', 'a')).toBe(true)
  })

  it('noteWrite returns false for a non-holder and does not steal the lock', () => {
    coord.attach('s1', 'a')
    expect(coord.noteWrite('s1', 'b')).toBe(false)
    expect(coord.canWrite('s1', 'a')).toBe(true)
    expect(coord.canWrite('s1', 'b')).toBe(false)
  })

  it('dropClient removes a client from all sessions and reassigns held locks', () => {
    coord.attach('s1', 'a')
    coord.attach('s1', 'b')
    coord.attach('s2', 'a')

    coord.dropClient('a')

    expect(coord.isViewer('s1', 'a')).toBe(false)
    expect(coord.canWrite('s1', 'b')).toBe(true)
    expect(coord.viewers('s2')).toBe(0)
  })

  it('emits change events scoped to the affected sessionId', () => {
    const seen: string[] = []
    coord.on('change', (sessionId) => seen.push(sessionId))

    coord.attach('s1', 'a')
    coord.attach('s2', 'b')
    coord.detach('s1', 'a')

    expect(seen).toEqual(['s1', 's2', 's1'])
  })

  it('off removes the listener', () => {
    const listener = vi.fn()
    coord.on('change', listener)
    coord.off('change', listener)
    coord.attach('s1', 'a')
    expect(listener).not.toHaveBeenCalled()
  })
})
