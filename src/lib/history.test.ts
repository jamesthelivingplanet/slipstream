import { describe, it, expect } from 'vitest'
import { filterHistory, formatWhen, resultLabel } from './history.js'
import type { SessionHistoryEntry, SessionDTO } from '../../electron/shared/contract.js'

// ─── fixtures ───────────────────────────────────────────────────────────────

function session(overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'sess-1',
    tid: 'PROJ-1',
    title: 'Fix the thing',
    prompt: 'Please fix the thing',
    repoId: 'repo-1',
    branch: 'proj-1-fix-the-thing',
    status: 'done',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function entry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    session: session(),
    outcome: null,
    usage: null,
    ...overrides,
  }
}

// ─── filterHistory ────────────────────────────────────────────────────────────

describe('filterHistory', () => {
  it('returns all entries when opts is empty', () => {
    const entries = [entry(), entry({ session: session({ id: 'sess-2' }) })]
    expect(filterHistory(entries, {})).toEqual(entries)
  })

  it('filters by repoId', () => {
    const a = entry({ session: session({ id: 'a', repoId: 'repo-a' }) })
    const b = entry({ session: session({ id: 'b', repoId: 'repo-b' }) })
    expect(filterHistory([a, b], { repoId: 'repo-a' })).toEqual([a])
  })

  it('does not filter by repoId when null/undefined/empty', () => {
    const a = entry({ session: session({ id: 'a', repoId: 'repo-a' }) })
    const b = entry({ session: session({ id: 'b', repoId: 'repo-b' }) })
    expect(filterHistory([a, b], { repoId: null })).toEqual([a, b])
    expect(filterHistory([a, b], { repoId: undefined })).toEqual([a, b])
    expect(filterHistory([a, b], { repoId: '' })).toEqual([a, b])
  })

  it('filters by outcome result', () => {
    const success = entry({
      session: session({ id: 'a' }),
      outcome: { sessionId: 'a', result: 'success', summary: 'ok', reportedAt: 1 },
    })
    const failure = entry({
      session: session({ id: 'b' }),
      outcome: { sessionId: 'b', result: 'failure', summary: 'nope', reportedAt: 1 },
    })
    expect(filterHistory([success, failure], { result: 'success' })).toEqual([success])
    expect(filterHistory([success, failure], { result: 'failure' })).toEqual([failure])
  })

  it("filters by result: 'none' keeps only entries with no outcome", () => {
    const withOutcome = entry({
      session: session({ id: 'a' }),
      outcome: { sessionId: 'a', result: 'success', summary: 'ok', reportedAt: 1 },
    })
    const withoutOutcome = entry({ session: session({ id: 'b' }), outcome: null })
    expect(filterHistory([withOutcome, withoutOutcome], { result: 'none' })).toEqual([
      withoutOutcome,
    ])
  })

  it('does not filter by result when null/undefined', () => {
    const a = entry({ session: session({ id: 'a' }) })
    const b = entry({
      session: session({ id: 'b' }),
      outcome: { sessionId: 'b', result: 'partial', summary: 'meh', reportedAt: 1 },
    })
    expect(filterHistory([a, b], { result: null })).toEqual([a, b])
    expect(filterHistory([a, b], { result: undefined })).toEqual([a, b])
  })

  it('matches query against title, prompt, tid, branch, and outcome summary (case-insensitive)', () => {
    const byTitle = entry({ session: session({ id: 'a', title: 'Refactor Widgets' }) })
    const byPrompt = entry({ session: session({ id: 'b', prompt: 'Add a WIDGET factory' }) })
    const byTid = entry({ session: session({ id: 'c', tid: 'WIDGET-9' }) })
    const byBranch = entry({ session: session({ id: 'd', branch: 'widget-cleanup' }) })
    const bySummary = entry({
      session: session({ id: 'e' }),
      outcome: { sessionId: 'e', result: 'success', summary: 'Shipped the widget', reportedAt: 1 },
    })
    const noMatch = entry({ session: session({ id: 'f', title: 'Unrelated' }) })

    const all = [byTitle, byPrompt, byTid, byBranch, bySummary, noMatch]
    expect(filterHistory(all, { query: 'widget' })).toEqual([
      byTitle,
      byPrompt,
      byTid,
      byBranch,
      bySummary,
    ])
  })

  it('does not filter by query when empty/whitespace-only', () => {
    const a = entry({ session: session({ id: 'a' }) })
    const b = entry({ session: session({ id: 'b' }) })
    expect(filterHistory([a, b], { query: '' })).toEqual([a, b])
    expect(filterHistory([a, b], { query: '   ' })).toEqual([a, b])
    expect(filterHistory([a, b], { query: undefined })).toEqual([a, b])
  })

  it('combines repo, result, and query filters (AND semantics)', () => {
    const match = entry({
      session: session({ id: 'a', repoId: 'repo-a', title: 'Fix login bug' }),
      outcome: { sessionId: 'a', result: 'success', summary: 'done', reportedAt: 1 },
    })
    const wrongRepo = entry({
      session: session({ id: 'b', repoId: 'repo-b', title: 'Fix login bug' }),
      outcome: { sessionId: 'b', result: 'success', summary: 'done', reportedAt: 1 },
    })
    const wrongResult = entry({
      session: session({ id: 'c', repoId: 'repo-a', title: 'Fix login bug' }),
      outcome: { sessionId: 'c', result: 'failure', summary: 'nope', reportedAt: 1 },
    })
    const wrongQuery = entry({
      session: session({ id: 'd', repoId: 'repo-a', title: 'Unrelated task' }),
      outcome: { sessionId: 'd', result: 'success', summary: 'done', reportedAt: 1 },
    })
    const all = [match, wrongRepo, wrongResult, wrongQuery]
    expect(filterHistory(all, { repoId: 'repo-a', result: 'success', query: 'login' })).toEqual([
      match,
    ])
  })

  it('preserves the relative order of entries (filter, not sort)', () => {
    const a = entry({ session: session({ id: 'a' }) })
    const b = entry({ session: session({ id: 'b' }) })
    const c = entry({ session: session({ id: 'c' }) })
    expect(filterHistory([c, a, b], {})).toEqual([c, a, b])
  })
})

// ─── formatWhen ───────────────────────────────────────────────────────────────

describe('formatWhen', () => {
  it('formats a time earlier the same local day as HH:MM', () => {
    const now = new Date(2025, 2, 4, 14, 30).getTime() // Mar 4 2025, 14:30
    const t = new Date(2025, 2, 4, 9, 5).getTime()
    expect(formatWhen(t, now)).toBe('09:05')
  })

  it('zero-pads hours and minutes under 10', () => {
    const now = new Date(2025, 2, 4, 23, 59).getTime()
    const t = new Date(2025, 2, 4, 0, 3).getTime()
    expect(formatWhen(t, now)).toBe('00:03')
  })

  it('formats the exact same instant as HH:MM', () => {
    const now = new Date(2025, 2, 4, 14, 30).getTime()
    expect(formatWhen(now, now)).toBe('14:30')
  })

  it('falls back to "Mon D" just before local midnight boundary (previous day)', () => {
    const now = new Date(2025, 2, 4, 0, 0).getTime() // Mar 4, 00:00
    const t = new Date(2025, 2, 3, 23, 59).getTime() // Mar 3, 23:59 — one minute earlier, different day
    expect(formatWhen(t, now)).toBe('Mar 3')
  })

  it('formats a different day in the same year as "Mon D"', () => {
    const now = new Date(2025, 5, 15, 10, 0).getTime() // Jun 15 2025
    const t = new Date(2025, 2, 4, 9, 5).getTime() // Mar 4 2025
    expect(formatWhen(t, now)).toBe('Mar 4')
  })

  it('formats a different year as "Mon D YYYY"', () => {
    const now = new Date(2026, 5, 15, 10, 0).getTime() // Jun 15 2026
    const t = new Date(2025, 2, 4, 9, 5).getTime() // Mar 4 2025
    expect(formatWhen(t, now)).toBe('Mar 4 2025')
  })

  it('defaults `now` to Date.now() when omitted', () => {
    const nowish = Date.now()
    expect(formatWhen(nowish)).toMatch(/^\d{2}:\d{2}$/)
  })
})

// ─── resultLabel ──────────────────────────────────────────────────────────────

describe('resultLabel', () => {
  it('maps each OutcomeResult to a human label', () => {
    expect(resultLabel('success')).toBe('Success')
    expect(resultLabel('partial')).toBe('Partial')
    expect(resultLabel('failure')).toBe('Failure')
  })

  it('returns "No outcome" for null/undefined', () => {
    expect(resultLabel(null)).toBe('No outcome')
    expect(resultLabel(undefined)).toBe('No outcome')
  })
})
