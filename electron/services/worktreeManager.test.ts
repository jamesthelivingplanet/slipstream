import { describe, it, expect } from 'vitest'
import {
  parsePorcelainDirty,
  parseRevListCount,
  parseShortstat,
  parsePorcelainWorktreeList,
  createWorktreeManager,
  isMissingWorktreeError,
} from './worktreeManager.js'
import type { RepoDTO } from '../shared/contract.js'

// ── parsePorcelainDirty ───────────────────────────────────────────────────────

describe('parsePorcelainDirty', () => {
  it('returns false for empty output (clean)', () => {
    expect(parsePorcelainDirty('')).toBe(false)
    expect(parsePorcelainDirty('   \n  ')).toBe(false)
  })

  it('returns true when there are changed files', () => {
    expect(parsePorcelainDirty(' M src/index.ts\n')).toBe(true)
    expect(parsePorcelainDirty('?? untracked.txt')).toBe(true)
  })
})

// ── parseRevListCount ─────────────────────────────────────────────────────────

describe('parseRevListCount', () => {
  it('parses behind\tahead correctly', () => {
    expect(parseRevListCount('3\t5\n')).toEqual({ behind: 3, ahead: 5 })
  })

  it('handles zero values', () => {
    expect(parseRevListCount('0\t0')).toEqual({ behind: 0, ahead: 0 })
  })

  it('handles spaces instead of tabs (robustness)', () => {
    expect(parseRevListCount('2 7')).toEqual({ behind: 2, ahead: 7 })
  })

  it('defaults to 0 on garbage input', () => {
    expect(parseRevListCount('')).toEqual({ behind: 0, ahead: 0 })
    expect(parseRevListCount('abc\txyz')).toEqual({ behind: 0, ahead: 0 })
  })
})

// ── parseShortstat ────────────────────────────────────────────────────────────

describe('parseShortstat', () => {
  it('parses a full shortstat line', () => {
    expect(
      parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)')
    ).toEqual({ added: 12, deleted: 4 })
  })

  it('parses insertions-only output', () => {
    expect(parseShortstat(' 1 file changed, 5 insertions(+)')).toEqual({ added: 5, deleted: 0 })
  })

  it('parses deletions-only output', () => {
    expect(parseShortstat(' 1 file changed, 3 deletions(-)')).toEqual({ added: 0, deleted: 3 })
  })

  it('returns zeros for empty output (no diff)', () => {
    expect(parseShortstat('')).toEqual({ added: 0, deleted: 0 })
  })
})

// ── parsePorcelainWorktreeList ────────────────────────────────────────────────

const WORKTREE_PORCELAIN = `\
worktree /home/user/repo
HEAD abc1234def5678901234567890abcdef01234567
branch refs/heads/main

worktree /home/user/.worktrees/acme-api/feature-x
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature-x

worktree /home/user/.worktrees/acme-api/fix-bug
HEAD cccccccccccccccccccccccccccccccccccccccc
branch refs/heads/fix-bug
`

describe('parsePorcelainWorktreeList', () => {
  it('parses all stanzas', () => {
    const result = parsePorcelainWorktreeList(WORKTREE_PORCELAIN)
    expect(result).toHaveLength(3)
  })

  it('strips refs/heads/ prefix from branch names', () => {
    const result = parsePorcelainWorktreeList(WORKTREE_PORCELAIN)
    expect(result.map((r) => r.branch)).toEqual(['main', 'feature-x', 'fix-bug'])
  })

  it('captures the correct paths', () => {
    const result = parsePorcelainWorktreeList(WORKTREE_PORCELAIN)
    expect(result[0].path).toBe('/home/user/repo')
    expect(result[1].path).toBe('/home/user/.worktrees/acme-api/feature-x')
  })

  it('returns empty array for empty input', () => {
    expect(parsePorcelainWorktreeList('')).toEqual([])
  })

  it('ignores detached HEAD stanzas (no branch line)', () => {
    const detached = `worktree /tmp/detached\nHEAD aaaa\ndetached\n`
    expect(parsePorcelainWorktreeList(detached)).toEqual([])
  })
})

// ── pathFor ───────────────────────────────────────────────────────────────────

describe('pathFor', () => {
  const repo: RepoDTO = { id: 'acme-api', org: 'acme', name: 'api', base: 'main', path: '/repos/api' }

  it('produces the correct path', () => {
    const mgr = createWorktreeManager('/home/user/slipstream-data')
    expect(mgr.pathFor(repo, 'feature-x')).toBe(
      '/home/user/slipstream-data/.worktrees/acme-api/feature-x',
    )
  })

  it('is pure — same inputs, same output', () => {
    const mgr = createWorktreeManager('/data')
    const a = mgr.pathFor(repo, 'my-branch')
    const b = mgr.pathFor(repo, 'my-branch')
    expect(a).toBe(b)
  })

  it('uses org-name as the intermediate directory', () => {
    const mgr = createWorktreeManager('/root')
    const p = mgr.pathFor({ ...repo, org: 'myOrg', name: 'myRepo' }, 'br')
    expect(p).toContain('myOrg-myRepo')
  })
})

// ── isMissingWorktreeError ────────────────────────────────────────────────────

describe('isMissingWorktreeError', () => {
  it('returns true for "not a working tree" errors', () => {
    expect(isMissingWorktreeError(new Error("git worktree remove failed: fatal: '/x' is not a working tree"))).toBe(true)
  })

  it('returns true for "No such file or directory" errors', () => {
    expect(isMissingWorktreeError(new Error('No such file or directory'))).toBe(true)
  })

  it('returns true for "not a git repository" errors', () => {
    expect(isMissingWorktreeError(new Error('not a git repository'))).toBe(true)
  })

  it('returns false for other git errors', () => {
    expect(isMissingWorktreeError(new Error('some other git failure'))).toBe(false)
  })
})
