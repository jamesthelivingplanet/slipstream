import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAgentsMd, resolveInfoExclude } from './promptWriter.js'

/**
 * Exercises writeAgentsMd against a REAL temp git repo + linked worktree — the
 * exact layout Slipstream uses for OpenCode agent runs. No native modules, so it
 * runs under plain node/vitest.
 */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

let root: string
let repoPath: string
let wtPath: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'slipstream-pw-'))
  repoPath = join(root, 'source')
  execFileSync('git', ['init', '-b', 'main', repoPath], { encoding: 'utf8' })
  git(repoPath, 'config', 'user.email', 'test@slipstream.dev')
  git(repoPath, 'config', 'user.name', 'Slipstream Test')
  // a tracked .gitignore that already exists (the case that previously got dirtied)
  const orig = 'node_modules\n'
  writeFileSync(join(repoPath, '.gitignore'), orig)
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', 'init')

  wtPath = join(root, 'wt-oc')
  git(repoPath, 'worktree', 'add', wtPath, '-b', 'feat-oc', 'main')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('promptWriter (real git)', () => {
  it('resolveInfoExclude points at an info/exclude path', () => {
    const p = resolveInfoExclude(wtPath)
    expect(p).not.toBeNull()
    expect(p!.replace(/\\/g, '/')).toMatch(/info\/exclude$/)
  })

  it('resolveInfoExclude returns null for a non-git directory', () => {
    const nowhere = join(root, 'not-a-repo')
    mkdirSync(nowhere, { recursive: true })
    expect(resolveInfoExclude(nowhere)).toBeNull()
  })

  it('writes AGENTS.md and keeps the worktree clean (FLO-36)', () => {
    writeAgentsMd(wtPath, '# system prompt\n')
    expect(readFileSync(join(wtPath, 'AGENTS.md'), 'utf8')).toBe('# system prompt\n')

    // AGENTS.md is ignored — cleanup guard keys off porcelain being empty.
    expect(git(wtPath, 'status', '--porcelain').trim()).toBe('')
    expect(git(wtPath, 'check-ignore', 'AGENTS.md').trim()).toBe('AGENTS.md')
  })

  it('does not modify the tracked .gitignore', () => {
    // The pre-existing tracked .gitignore is untouched.
    expect(readFileSync(join(wtPath, '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(git(wtPath, 'status', '--porcelain', '.gitignore').trim()).toBe('')
  })

  it('is idempotent — a second write does not duplicate the ignore entry', () => {
    writeAgentsMd(wtPath, '# updated prompt\n')
    writeAgentsMd(wtPath, '# updated prompt\n')
    const exclude = resolveInfoExclude(wtPath)!
    const matches = readFileSync(exclude, 'utf8')
      .split('\n')
      .filter((l) => l.trim() === 'AGENTS.md').length
    expect(matches).toBe(1)
    // still clean
    expect(git(wtPath, 'status', '--porcelain').trim()).toBe('')
  })

  it('keeps the worktree clean even when the repo has no .gitignore', () => {
    // A repo that never committed a .gitignore at all.
    const repo2 = join(root, 'source2')
    execFileSync('git', ['init', '-b', 'main', repo2], { encoding: 'utf8' })
    git(repo2, 'config', 'user.email', 'test@slipstream.dev')
    git(repo2, 'config', 'user.name', 'Slipstream Test')
    writeFileSync(join(repo2, 'README.md'), 'hi\n')
    git(repo2, 'add', '-A')
    git(repo2, 'commit', '-m', 'init')

    const wt2 = join(root, 'wt-no-ignore')
    git(repo2, 'worktree', 'add', wt2, '-b', 'feat-no-ignore', 'main')
    expect(existsSync(join(wt2, '.gitignore'))).toBe(false)

    writeAgentsMd(wt2, '# prompt\n')
    expect(existsSync(join(wt2, 'AGENTS.md'))).toBe(true)
    expect(git(wt2, 'status', '--porcelain').trim()).toBe('')
    expect(git(wt2, 'check-ignore', 'AGENTS.md').trim()).toBe('AGENTS.md')
  })
})
