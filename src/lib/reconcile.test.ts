import { describe, it, expect } from 'vitest'
import { sessionsToReconcile } from './reconcile.js'
import type { Session } from './types.js'

describe('sessionsToReconcile', () => {
  it('returns sessions whose tid matches a done=true dto', () => {
    const sessions = [
      { tid: 'A' } as Session,
      { tid: 'B' } as Session,
    ]
    const dtos = [
      { tid: 'A', done: true },
      { tid: 'B', done: false },
    ]
    expect(sessionsToReconcile(sessions, dtos)).toEqual([{ tid: 'A' }])
  })

  it('ignores done dtos with no matching session', () => {
    const sessions = [{ tid: 'B' } as Session]
    const dtos = [{ tid: 'A', done: true }]
    expect(sessionsToReconcile(sessions, dtos)).toEqual([])
  })

  it('ignores sessions whose dto is done=false', () => {
    const sessions = [{ tid: 'A' } as Session]
    const dtos = [{ tid: 'A', done: false }]
    expect(sessionsToReconcile(sessions, dtos)).toEqual([])
  })

  it('ignores sessions with no dto at all', () => {
    const sessions = [{ tid: 'A' } as Session]
    const dtos: { tid: string; done: boolean }[] = []
    expect(sessionsToReconcile(sessions, dtos)).toEqual([])
  })
})
