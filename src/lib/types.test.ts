import { describe, it, expect } from 'vitest'
import { statusBucket, type Status } from './types.js'

describe('statusBucket (FLO-113)', () => {
  const cases: [Status, ReturnType<typeof statusBucket>][] = [
    ['needs', 'needs'],
    ['errored', 'needs'],
    ['running', 'running'],
    ['detached', 'running'],
    ['queued', 'running'],
    ['done', 'done'],
    ['idle', null],
    ['interrupted', null],
    ['reaped', null],
    ['tearing-down', null],
  ]

  it.each(cases)('maps %s to %s', (status, expected) => {
    expect(statusBucket(status)).toBe(expected)
  })

  it('covers every Status variant exactly once', () => {
    const statuses: Status[] = cases.map(([s]) => s)
    expect(new Set(statuses).size).toBe(statuses.length)
    expect(statuses).toHaveLength(10)
  })
})
