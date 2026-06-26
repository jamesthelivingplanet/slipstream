import { describe, it, expect } from 'vitest'
import { selectNewestSessionSince } from './opencodeSessions.js'
import type { OpencodeSession } from './opencodeSessions.js'

// ── selectNewestSessionSince ─────────────────────────────────────────────────

describe('selectNewestSessionSince', () => {
  const sinceMs = 1000

  it('returns null for empty array', () => {
    expect(selectNewestSessionSince([], sinceMs)).toBeNull()
  })

  it('returns null when no session is at or after sinceMs', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_a', time_created: 100 },
      { id: 'ses_b', time_created: 999 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBeNull()
  })

  it('returns the newest among several at or after sinceMs', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_a', time_created: 1000 },
      { id: 'ses_b', time_created: 2000 },
      { id: 'ses_c', time_created: 1500 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_b')
  })

  it('returns the single qualifying session when older ones exist', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_a', time_created: 50 },
      { id: 'ses_b', time_created: 3000 },
      { id: 'ses_c', time_created: 10 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_b')
  })

  it('ignores sessions older than sinceMs regardless of id', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_zzz', time_created: 500 },
      { id: 'ses_aaa', time_created: 5000 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_aaa')
  })

  it('treats a session exactly equal to sinceMs as qualifying', () => {
    const sessions: OpencodeSession[] = [
      { id: 'ses_exact', time_created: 1000 },
    ]
    expect(selectNewestSessionSince(sessions, sinceMs)).toBe('ses_exact')
  })
})
