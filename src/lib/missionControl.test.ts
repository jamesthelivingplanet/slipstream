import { describe, it, expect } from 'vitest'
import {
  stripAnsi,
  extractAsk,
  formatWait,
  suggestedReplies,
  prChips,
  prNotMerged,
  computeUsageRollup,
  costFor,
  findParentTitle,
  countSpawned,
  sessionsNeedingAskFetch,
  staleAskFetchIds,
  sessionSwipeKey,
  nextHandoffFor,
} from './missionControl.js'
import type { PrStatusDTO, SessionUsage, UsageSummary } from '../../electron/shared/contract.js'
import type { Session } from './types'

function mkSession(overrides: Partial<Session> & { tid: string }): Session {
  return {
    src: 'github',
    status: 'idle',
    title: overrides.tid,
    repo: 'r1',
    branch: null,
    add: 0,
    del: 0,
    behind: 0,
    ago: 'just now',
    activity: { text: '' },
    ...overrides,
  }
}

function mkPr(overrides: Partial<PrStatusDTO> = {}): PrStatusDTO {
  return {
    sessionId: 's1',
    url: 'https://example.com/pr/1',
    host: 'github',
    state: 'open',
    ci: 'none',
    review: 'none',
    approvals: 0,
    checkedAt: 0,
    ...overrides,
  }
}

function mkUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId: 's1',
    exists: true,
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    costUsd: 0,
    turns: 1,
    ...overrides,
  }
}

// ─── stripAnsi ────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes CSI color sequences', () => {
    expect(stripAnsi('\x1B[32mhello\x1B[0m')).toBe('hello')
  })

  it('removes cursor movement sequences', () => {
    expect(stripAnsi('\x1B[2J\x1B[H')).toBe('')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here')
  })
})

// ─── extractAsk ───────────────────────────────────────────────────────────────

describe('extractAsk', () => {
  it('returns null for an empty buffer', () => {
    expect(extractAsk('')).toBeNull()
  })

  it('returns null for a whitespace-only buffer', () => {
    expect(extractAsk('   \n  \n')).toBeNull()
  })

  it('extracts a plain trailing question', () => {
    expect(extractAsk('I found 3 issues.\nShould I fix them all?')).toBe('Should I fix them all?')
  })

  it('extracts a [y/n]-style prompt', () => {
    expect(extractAsk('Remove unused imports?\nRemove unused imports? [y/n]')).toBe(
      'Remove unused imports? [y/n]',
    )
  })

  it('extracts a (y/N) prompt with no trailing question mark', () => {
    expect(extractAsk('Overwrite the file (y/N)')).toBe('Overwrite the file (y/N)')
  })

  it('extracts a [Y/n] prompt', () => {
    expect(extractAsk('Proceed with deploy [Y/n]')).toBe('Proceed with deploy [Y/n]')
  })

  it('extracts a multi-line numbered-menu question block', () => {
    const buf = 'Working on it...\nPick an option:\n1. Deploy now\n2. Cancel'
    expect(extractAsk(buf)).toBe('Pick an option: 1. Deploy now 2. Cancel')
  })

  it('does not extend the menu block past a non-question header', () => {
    // The line before the numbered options is not question-like, so there's
    // no valid header to anchor the block — treat as no question found.
    const buf = 'Some progress log\n1. Deploy now\n2. Cancel'
    expect(extractAsk(buf)).toBeNull()
  })

  it('strips ANSI color codes before matching', () => {
    expect(extractAsk('\x1B[33mShould I\x1B[0m continue?')).toBe('Should I continue?')
  })

  it('collapses internal whitespace and trims', () => {
    expect(extractAsk('Should   I   continue?  ')).toBe('Should I continue?')
  })

  it('ignores trailing blank lines when finding the last line', () => {
    expect(extractAsk('Should I continue?\n\n\n')).toBe('Should I continue?')
  })

  it('returns null for plain non-question output', () => {
    expect(extractAsk('Installing dependencies...\nAdded 42 packages')).toBeNull()
  })

  it('returns null when the tail ends with a colon-less, question-less statement', () => {
    expect(extractAsk('All tests passed')).toBeNull()
  })

  it('only inspects roughly the last 2000 chars of a large buffer', () => {
    const noise = 'x'.repeat(5000)
    expect(extractAsk(`Should I proceed?\n${noise}`)).toBeNull()
  })

  it('still finds the question when it falls within the tail window of a large buffer', () => {
    const noise = 'progress line\n'.repeat(300) // well under 2000 chars of trailing noise once we append the question
    const buf = `${noise}Should I proceed?`
    expect(extractAsk(buf)).toBe('Should I proceed?')
  })

  it('truncates long questions to maxLen with an ellipsis', () => {
    const longQuestion = `Should I ${'really '.repeat(40)}proceed?`
    const result = extractAsk(longQuestion)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(160)
    expect(result!.endsWith('…')).toBe(true)
  })

  it('respects a custom maxLen', () => {
    const question = 'Should I proceed with this very long and detailed plan of action?'
    const result = extractAsk(question, 20)
    expect(result!.length).toBeLessThanOrEqual(20)
    expect(result!.endsWith('…')).toBe(true)
  })

  it('does not truncate when the question fits within maxLen', () => {
    expect(extractAsk('Continue?', 20)).toBe('Continue?')
  })
})

// ─── suggestedReplies ───────────────────────────────────────────────────────────

describe('suggestedReplies', () => {
  it('returns [] for null', () => {
    expect(suggestedReplies(null)).toEqual([])
  })

  it('returns [] for undefined', () => {
    expect(suggestedReplies(undefined)).toEqual([])
  })

  it('returns [] for an empty string', () => {
    expect(suggestedReplies('')).toEqual([])
  })

  it('returns [] for a whitespace-only string', () => {
    expect(suggestedReplies('   ')).toEqual([])
  })

  it('matches a trailing [y/n] prompt', () => {
    expect(suggestedReplies('Remove unused imports? [y/n]')).toEqual(['y', 'n'])
  })

  it('matches a trailing (y/N) prompt and preserves the default-hint casing', () => {
    expect(suggestedReplies('Overwrite the file (y/N)')).toEqual(['y', 'N'])
  })

  it('matches a trailing [Y/n] prompt and preserves the default-hint casing', () => {
    expect(suggestedReplies('Proceed with deploy [Y/n]')).toEqual(['Y', 'n'])
  })

  it('matches a trailing "yes/no?" prompt', () => {
    expect(suggestedReplies('Should I delete this? yes/no?')).toEqual(['y', 'n'])
  })

  it('matches a trailing "proceed?" question', () => {
    expect(suggestedReplies('Should I proceed?')).toEqual(['Yes', 'No'])
  })

  it('matches a trailing "continue?" question', () => {
    expect(suggestedReplies('Continue?')).toEqual(['Yes', 'No'])
  })

  it('matches "shall I proceed" phrasing', () => {
    expect(suggestedReplies('Shall I proceed with the migration?')).toEqual(['Yes', 'No'])
  })

  it('returns [] for an open-ended question', () => {
    expect(suggestedReplies('What should I name this branch?')).toEqual([])
  })

  it('returns [] for a multi-choice menu question', () => {
    expect(suggestedReplies('Pick an option: 1. Deploy now 2. Cancel')).toEqual([])
  })

  it('returns [] for plain non-question text', () => {
    expect(suggestedReplies('Installing dependencies...')).toEqual([])
  })
})

// ─── formatWait ───────────────────────────────────────────────────────────────

describe('formatWait', () => {
  it('returns "<1m" for elapsed under a minute', () => {
    expect(formatWait(0, 0)).toBe('<1m')
    expect(formatWait(0, 59_999)).toBe('<1m')
  })

  it('returns "1m" right at the one-minute boundary', () => {
    expect(formatWait(0, 60_000)).toBe('1m')
  })

  it('returns minutes under an hour', () => {
    expect(formatWait(0, 4 * 60_000)).toBe('4m')
    expect(formatWait(0, 59 * 60_000)).toBe('59m')
  })

  it('returns "1h 0m" right at the one-hour boundary', () => {
    expect(formatWait(0, 60 * 60_000)).toBe('1h 0m')
  })

  it('returns hours and minutes under a day', () => {
    const ms = 60 * 60_000 + 12 * 60_000 // 1h 12m
    expect(formatWait(0, ms)).toBe('1h 12m')
  })

  it('returns "23h 59m" just under the one-day boundary', () => {
    const ms = 24 * 60 * 60_000 - 60_000
    expect(formatWait(0, ms)).toBe('23h 59m')
  })

  it('returns "1d" right at the one-day boundary', () => {
    expect(formatWait(0, 24 * 60 * 60_000)).toBe('1d')
  })

  it('returns days for multi-day elapsed', () => {
    expect(formatWait(0, 2 * 24 * 60 * 60_000)).toBe('2d')
  })

  it('defaults `now` to Date.now() when omitted', () => {
    const since = Date.now() - 5000
    expect(formatWait(since)).toBe('<1m')
  })

  it('clamps negative elapsed (since in the future) to "<1m"', () => {
    expect(formatWait(10_000, 0)).toBe('<1m')
  })
})

// ─── prChips ────────────────────────────────────────────────────────────────

describe('prChips', () => {
  it('returns [] for undefined', () => {
    expect(prChips(undefined)).toEqual([])
  })

  it('collapses an error to a single "PR ?" chip', () => {
    expect(prChips(mkPr({ error: 'no token', state: 'merged', ci: 'passed' }))).toEqual([
      { text: 'PR ?', cls: 'muted' },
    ])
  })

  it('orders merge state, CI, review chips', () => {
    expect(prChips(mkPr({ state: 'merged', ci: 'passed', review: 'approved' }))).toEqual([
      { text: 'merged', cls: 'done' },
      { text: 'CI ✓', cls: 'done' },
      { text: 'approved', cls: 'done' },
    ])
  })

  it('omits none/unknown CI and review states', () => {
    expect(prChips(mkPr({ state: 'open', ci: 'none', review: 'none' }))).toEqual([
      { text: 'open', cls: 'muted' },
    ])
    expect(prChips(mkPr({ state: 'open', ci: 'unknown', review: 'unknown' }))).toEqual([
      { text: 'open', cls: 'muted' },
    ])
  })

  it('marks closed as an error chip and failed CI as an error chip', () => {
    expect(prChips(mkPr({ state: 'closed', ci: 'failed' }))).toEqual([
      { text: 'closed', cls: 'error' },
      { text: 'CI ✗', cls: 'error' },
    ])
  })

  it('marks pending/running CI as a "needs" chip', () => {
    expect(prChips(mkPr({ ci: 'pending' }))[1]).toEqual({ text: 'CI …', cls: 'needs' })
    expect(prChips(mkPr({ ci: 'running' }))[1]).toEqual({ text: 'CI …', cls: 'needs' })
  })

  it('marks changes_requested review as an error chip', () => {
    expect(prChips(mkPr({ review: 'changes_requested' }))).toEqual([
      { text: 'open', cls: 'muted' },
      { text: 'changes', cls: 'error' },
    ])
  })
})

// ─── prNotMerged ────────────────────────────────────────────────────────────

describe('prNotMerged', () => {
  it('returns false for undefined', () => {
    expect(prNotMerged(undefined)).toBe(false)
  })

  it('returns false for state "unknown"', () => {
    expect(prNotMerged(mkPr({ state: 'unknown' }))).toBe(false)
  })

  it('returns false for state "merged"', () => {
    expect(prNotMerged(mkPr({ state: 'merged' }))).toBe(false)
  })

  it('returns true for state "open"', () => {
    expect(prNotMerged(mkPr({ state: 'open' }))).toBe(true)
  })

  it('returns true for state "closed"', () => {
    expect(prNotMerged(mkPr({ state: 'closed' }))).toBe(true)
  })
})

// ─── computeUsageRollup ─────────────────────────────────────────────────────

describe('computeUsageRollup', () => {
  it('returns empty map, zero cost, hasUsage=false for null usage', () => {
    const r = computeUsageRollup(null, 0)
    expect(r.usageById.size).toBe(0)
    expect(r.todayCost).toBe(0)
    expect(r.hasUsage).toBe(false)
  })

  it('indexes sessions by sessionId', () => {
    const usage: UsageSummary = {
      total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      costUsd: 1.5,
      byRepo: [],
      byDay: [],
      sessions: [mkUsage({ sessionId: 'a' }), mkUsage({ sessionId: 'b' })],
    }
    const r = computeUsageRollup(usage, 0)
    expect(r.usageById.size).toBe(2)
    expect(r.usageById.get('a')?.sessionId).toBe('a')
  })

  it('finds todayCost from byDay using the day key of nowMs', () => {
    const now = Date.UTC(2026, 6, 30, 12, 0, 0) // 2026-07-30
    const usage: UsageSummary = {
      total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      costUsd: 3,
      byRepo: [],
      byDay: [
        {
          key: '2026-07-29',
          tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
          costUsd: 1,
          sessions: 1,
        },
        {
          key: '2026-07-30',
          tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
          costUsd: 2,
          sessions: 1,
        },
      ],
      sessions: [],
    }
    expect(computeUsageRollup(usage, now).todayCost).toBe(2)
  })

  it('hasUsage is true only when costUsd > 0', () => {
    const usage: UsageSummary = {
      total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      costUsd: 0,
      byRepo: [],
      byDay: [],
      sessions: [],
    }
    expect(computeUsageRollup(usage, 0).hasUsage).toBe(false)
    expect(computeUsageRollup({ ...usage, costUsd: 0.01 }, 0).hasUsage).toBe(true)
  })
})

// ─── costFor ────────────────────────────────────────────────────────────────

describe('costFor', () => {
  it('returns null for undefined', () => {
    expect(costFor(undefined)).toBeNull()
  })

  it('returns null when exists is false', () => {
    expect(costFor(mkUsage({ exists: false }))).toBeNull()
  })

  it('returns null when turns is 0', () => {
    expect(costFor(mkUsage({ turns: 0 }))).toBeNull()
  })

  it('formats cost and total tokens when usage exists with turns', () => {
    const u = mkUsage({
      costUsd: 1.23,
      tokens: { input: 10, output: 20, cacheCreation: 5, cacheRead: 5 },
    })
    const r = costFor(u)
    expect(r).not.toBeNull()
    expect(r!.cost).toBe('$1.23')
  })
})

// ─── findParentTitle ────────────────────────────────────────────────────────

describe('findParentTitle', () => {
  const sessions = [
    mkSession({ tid: 'T1', id: 'p1', title: 'Parent one' }),
    mkSession({ tid: 'T2', id: 'c1', parentId: 'p1', title: 'Child' }),
  ]

  it('returns undefined when parentId is undefined', () => {
    expect(findParentTitle(sessions, undefined)).toBeUndefined()
  })

  it('returns undefined when the parent is not a known session', () => {
    expect(findParentTitle(sessions, 'ghost')).toBeUndefined()
  })

  it('returns the parent session title', () => {
    expect(findParentTitle(sessions, 'p1')).toBe('Parent one')
  })
})

// ─── countSpawned ───────────────────────────────────────────────────────────

describe('countSpawned', () => {
  const sessions = [
    mkSession({ tid: 'T1', id: 'p1', title: 'Parent' }),
    mkSession({ tid: 'T2', id: 'c1', parentId: 'p1', title: 'Child 1' }),
    mkSession({ tid: 'T3', id: 'c2', parentId: 'p1', title: 'Child 2' }),
    mkSession({ tid: 'T4', id: 'other', title: 'Unrelated' }),
  ]

  it('returns 0 for undefined sessionId', () => {
    expect(countSpawned(sessions, undefined)).toBe(0)
  })

  it('returns 0 when nothing was spawned', () => {
    expect(countSpawned(sessions, 'other')).toBe(0)
  })

  it('counts sessions with matching parentId', () => {
    expect(countSpawned(sessions, 'p1')).toBe(2)
  })
})

// ─── ask-fetch cache guard (load-bearing — per-episode, not per-tick) ───────

describe('sessionsNeedingAskFetch', () => {
  it('returns ids of sessions in "needs" not yet fetched', () => {
    const list = [
      mkSession({ tid: 'T1', id: 'a', status: 'needs' }),
      mkSession({ tid: 'T2', id: 'b', status: 'running' }),
    ]
    expect(sessionsNeedingAskFetch(list, new Set())).toEqual(['a'])
  })

  it('skips a session already in fetchedFor', () => {
    const list = [mkSession({ tid: 'T1', id: 'a', status: 'needs' })]
    expect(sessionsNeedingAskFetch(list, new Set(['a']))).toEqual([])
  })

  it('skips sessions with no id', () => {
    const list = [mkSession({ tid: 'T1', status: 'needs' })]
    expect(sessionsNeedingAskFetch(list, new Set())).toEqual([])
  })

  it('does not re-fetch on a repeat tick where status is unchanged (per-episode guard)', () => {
    const list = [mkSession({ tid: 'T1', id: 'a', status: 'needs' })]
    const fetchedFor = new Set<string>()
    // First tick: newly entered 'needs'.
    expect(sessionsNeedingAskFetch(list, fetchedFor)).toEqual(['a'])
    fetchedFor.add('a')
    // Status flaps needs -> needs again on the next PTY-chunk tick (no
    // change) — must NOT be returned again.
    expect(sessionsNeedingAskFetch(list, fetchedFor)).toEqual([])
  })
})

describe('staleAskFetchIds', () => {
  it('returns ids whose session left "needs"', () => {
    const list = [mkSession({ tid: 'T1', id: 'a', status: 'running' })]
    expect(staleAskFetchIds(list, new Set(['a']))).toEqual(['a'])
  })

  it('returns ids whose session disappeared entirely', () => {
    const list: Session[] = []
    expect(staleAskFetchIds(list, new Set(['a']))).toEqual(['a'])
  })

  it('keeps an id whose session is still in "needs"', () => {
    const list = [mkSession({ tid: 'T1', id: 'a', status: 'needs' })]
    expect(staleAskFetchIds(list, new Set(['a']))).toEqual([])
  })

  it('re-arms a re-entering session: cleared then eligible again', () => {
    const fetchedFor = new Set<string>(['a'])
    const leftNeeds = [mkSession({ tid: 'T1', id: 'a', status: 'running' })]
    const stale = staleAskFetchIds(leftNeeds, fetchedFor)
    expect(stale).toEqual(['a'])
    for (const id of stale) fetchedFor.delete(id)
    expect(fetchedFor.size).toBe(0)

    const reentered = [mkSession({ tid: 'T1', id: 'a', status: 'needs' })]
    expect(sessionsNeedingAskFetch(reentered, fetchedFor)).toEqual(['a'])
  })
})

// ─── sessionSwipeKey ────────────────────────────────────────────────────────

describe('sessionSwipeKey', () => {
  it('uses the backend id when present', () => {
    expect(sessionSwipeKey(mkSession({ tid: 'T1', id: 'sess-1' }))).toBe('sess-1')
  })

  it('falls back to the ticket id when there is no backend id', () => {
    expect(sessionSwipeKey(mkSession({ tid: 'T1' }))).toBe('T1')
  })
})

// ─── nextHandoffFor ─────────────────────────────────────────────────────────

describe('nextHandoffFor', () => {
  it('opens a closed menu', () => {
    expect(nextHandoffFor(null, 'a')).toBe('a')
  })

  it('closes the currently-open menu when its key is selected again', () => {
    expect(nextHandoffFor('a', 'a')).toBeNull()
  })

  it('switches to a different row without needing an intermediate close', () => {
    expect(nextHandoffFor('a', 'b')).toBe('b')
  })
})
