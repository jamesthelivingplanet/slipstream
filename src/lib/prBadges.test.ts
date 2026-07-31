import { describe, it, expect } from 'vitest'
import { prBadges } from './prBadges.js'
import type { PrStatusDTO } from '../../electron/shared/contract.js'

function dto(overrides: Partial<PrStatusDTO> = {}): PrStatusDTO {
  return {
    sessionId: 's1',
    url: 'https://example.test/pr/1',
    host: 'github',
    state: 'unknown',
    ci: 'unknown',
    review: 'unknown',
    approvals: 0,
    checkedAt: 0,
    ...overrides,
  }
}

describe('prBadges', () => {
  it('returns [] for null', () => {
    expect(prBadges(null)).toEqual([])
  })

  it('returns a single muted "PR ?" badge when dto.error is set, ignoring other fields', () => {
    expect(
      prBadges(dto({ error: 'boom', state: 'merged', ci: 'passed', review: 'approved' })),
    ).toEqual([{ text: 'PR ?', cls: 'muted' }])
  })

  it('returns [] when state/ci/review are all "unknown"/"none"', () => {
    expect(prBadges(dto({ ci: 'none', review: 'none' }))).toEqual([])
  })

  it.each([
    ['merged', { text: 'merged', cls: 'done' }],
    ['open', { text: 'open', cls: 'muted' }],
    ['closed', { text: 'closed', cls: 'error' }],
  ] as const)('maps state %s', (state, badge) => {
    expect(prBadges(dto({ state }))).toEqual([badge])
  })

  it.each([
    ['passed', { text: 'CI ✓', cls: 'done' }],
    ['failed', { text: 'CI ✗', cls: 'error' }],
    ['pending', { text: 'CI …', cls: 'needs' }],
    ['running', { text: 'CI …', cls: 'needs' }],
  ] as const)('maps ci %s', (ci, badge) => {
    expect(prBadges(dto({ ci }))).toEqual([badge])
  })

  it.each([
    ['approved', { text: 'approved', cls: 'done' }],
    ['changes_requested', { text: 'changes', cls: 'error' }],
  ] as const)('maps review %s', (review, badge) => {
    expect(prBadges(dto({ review }))).toEqual([badge])
  })

  it('combines badges from state, ci, and review in that order', () => {
    expect(prBadges(dto({ state: 'open', ci: 'failed', review: 'changes_requested' }))).toEqual([
      { text: 'open', cls: 'muted' },
      { text: 'CI ✗', cls: 'error' },
      { text: 'changes', cls: 'error' },
    ])
  })
})
