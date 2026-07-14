import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeAgentsMd,
  resolveInfoExclude,
  writeSlipstreamSkill,
  writeOpencodeConfig,
  writeKiloConfig,
} from './promptWriter.js'

/**
 * Exercises writeAgentsMd against a REAL temp git repo + linked worktree — the
 * exact layout Slipstream uses for OpenCode agent runs. No native modules, so it
 * runs under plain node/vitest.
 */
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

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

  describe('writeSlipstreamSkill (FLO-104)', () => {
    it('writes the canonical skill under .agents/skills/slipstream', () => {
      writeSlipstreamSkill(wtPath)
      const md = readFileSync(join(wtPath, '.agents', 'skills', 'slipstream', 'SKILL.md'), 'utf8')
      expect(md).toContain('name: slipstream')
      expect(md).toContain('slipstream task-started')
    })

    it('symlinks .claude/skills/slipstream to the canonical dir (relative target)', () => {
      writeSlipstreamSkill(wtPath)
      const link = join(wtPath, '.claude', 'skills', 'slipstream')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join('..', '..', '.agents', 'skills', 'slipstream'))
      // The symlink resolves to a readable SKILL.md (Claude Code follows it).
      expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toContain('name: slipstream')
    })

    it('keeps the worktree clean — both paths excluded, parents untouched', () => {
      writeSlipstreamSkill(wtPath)
      expect(git(wtPath, 'status', '--porcelain').trim()).toBe('')
      expect(git(wtPath, 'check-ignore', '.claude/skills/slipstream').trim()).toBe(
        '.claude/skills/slipstream',
      )
      // Exact patterns only: a repo-owned sibling skill must NOT be ignored.
      expect(() => git(wtPath, 'check-ignore', '.claude/skills/setup')).toThrow()
    })

    it('is idempotent — re-running does not duplicate excludes or break the link', () => {
      writeSlipstreamSkill(wtPath)
      writeSlipstreamSkill(wtPath)
      const exclude = readFileSync(resolveInfoExclude(wtPath)!, 'utf8')
      const count = exclude
        .split('\n')
        .filter((l) => l.trim() === '.claude/skills/slipstream').length
      expect(count).toBe(1)
      expect(lstatSync(join(wtPath, '.claude', 'skills', 'slipstream')).isSymbolicLink()).toBe(true)
    })

    it('leaves a pre-existing REAL .claude/skills/slipstream directory alone', () => {
      const wt = join(root, 'wt-realskill')
      git(repoPath, 'worktree', 'add', wt, '-b', 'feat-realskill', 'main')
      const realDir = join(wt, '.claude', 'skills', 'slipstream')
      mkdirSync(realDir, { recursive: true })
      writeFileSync(join(realDir, 'SKILL.md'), 'repo-owned\n')

      writeSlipstreamSkill(wt)

      expect(lstatSync(realDir).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(realDir, 'SKILL.md'), 'utf8')).toBe('repo-owned\n')
      // Canonical copy still written for pi/opencode.
      expect(existsSync(join(wt, '.agents', 'skills', 'slipstream', 'SKILL.md'))).toBe(true)
    })
  })

  describe('writeOpencodeConfig', () => {
    it('creates opencode.json with permission:allow and excludes it', () => {
      const wt = join(root, 'wt-oc-config')
      git(repoPath, 'worktree', 'add', wt, '-b', 'feat-oc-config', 'main')

      writeOpencodeConfig(wt)

      const content = readFileSync(join(wt, 'opencode.json'), 'utf8')
      expect(content.endsWith('\n')).toBe(true)
      expect(JSON.parse(content)).toEqual({
        $schema: 'https://opencode.ai/config.json',
        permission: 'allow',
      })
      expect(git(wt, 'status', '--porcelain').trim()).toBe('')
      expect(git(wt, 'check-ignore', 'opencode.json').trim()).toBe('opencode.json')
    })

    it('skips and leaves a pre-existing opencode.json alone (no exclude entry added)', () => {
      // A fresh, independent repo — info/exclude is shared across all worktrees
      // of the SAME repo, so reusing repoPath here would see the previous
      // test's "opencode.json" entry and give a false positive.
      const repoOc = join(root, 'source-oc-existing')
      execFileSync('git', ['init', '-b', 'main', repoOc], { encoding: 'utf8' })
      git(repoOc, 'config', 'user.email', 'test@slipstream.dev')
      git(repoOc, 'config', 'user.name', 'Slipstream Test')
      writeFileSync(join(repoOc, 'README.md'), 'hi\n')
      git(repoOc, 'add', '-A')
      git(repoOc, 'commit', '-m', 'init')

      const wt = join(root, 'wt-oc-existing')
      git(repoOc, 'worktree', 'add', wt, '-b', 'feat-oc-existing', 'main')
      const original = '{"tracked":true}'
      writeFileSync(join(wt, 'opencode.json'), original)

      writeOpencodeConfig(wt)

      expect(readFileSync(join(wt, 'opencode.json'), 'utf8')).toBe(original)
      const exclude = resolveInfoExclude(wt)
      const excludeContent = exclude && existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      expect(
        excludeContent
          .split('\n')
          .map((l) => l.trim())
          .includes('opencode.json'),
      ).toBe(false)
    })
  })

  describe('writeKiloConfig', () => {
    it('creates kilo.jsonc with permission {"*": "allow"} and excludes it', () => {
      const wt = join(root, 'wt-kilo-config')
      git(repoPath, 'worktree', 'add', wt, '-b', 'feat-kilo-config', 'main')

      writeKiloConfig(wt)

      const content = readFileSync(join(wt, 'kilo.jsonc'), 'utf8')
      expect(content.endsWith('\n')).toBe(true)
      expect(JSON.parse(content)).toEqual({
        $schema: 'https://app.kilo.ai/config.json',
        permission: { '*': 'allow' },
      })
      expect(git(wt, 'status', '--porcelain').trim()).toBe('')
      expect(git(wt, 'check-ignore', 'kilo.jsonc').trim()).toBe('kilo.jsonc')
    })

    it('skips and leaves a pre-existing kilo.jsonc alone (no exclude entry added)', () => {
      // A fresh, independent repo — info/exclude is shared across all worktrees
      // of the SAME repo, so reusing repoPath here would see a previous
      // test's "kilo.jsonc" entry and give a false positive.
      const repoKilo = join(root, 'source-kilo-existing')
      execFileSync('git', ['init', '-b', 'main', repoKilo], { encoding: 'utf8' })
      git(repoKilo, 'config', 'user.email', 'test@slipstream.dev')
      git(repoKilo, 'config', 'user.name', 'Slipstream Test')
      writeFileSync(join(repoKilo, 'README.md'), 'hi\n')
      git(repoKilo, 'add', '-A')
      git(repoKilo, 'commit', '-m', 'init')

      const wt = join(root, 'wt-kilo-existing')
      git(repoKilo, 'worktree', 'add', wt, '-b', 'feat-kilo-existing', 'main')
      const original = '{"tracked":true}'
      writeFileSync(join(wt, 'kilo.jsonc'), original)

      writeKiloConfig(wt)

      expect(readFileSync(join(wt, 'kilo.jsonc'), 'utf8')).toBe(original)
      const exclude = resolveInfoExclude(wt)
      const excludeContent = exclude && existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      expect(
        excludeContent
          .split('\n')
          .map((l) => l.trim())
          .includes('kilo.jsonc'),
      ).toBe(false)
    })

    it('skips when only .kilo/kilo.jsonc exists (nested config takes priority, no exclude entry)', () => {
      const repoKiloNested = join(root, 'source-kilo-nested')
      execFileSync('git', ['init', '-b', 'main', repoKiloNested], { encoding: 'utf8' })
      git(repoKiloNested, 'config', 'user.email', 'test@slipstream.dev')
      git(repoKiloNested, 'config', 'user.name', 'Slipstream Test')
      writeFileSync(join(repoKiloNested, 'README.md'), 'hi\n')
      git(repoKiloNested, 'add', '-A')
      git(repoKiloNested, 'commit', '-m', 'init')

      const wt = join(root, 'wt-kilo-nested')
      git(repoKiloNested, 'worktree', 'add', wt, '-b', 'feat-kilo-nested', 'main')
      mkdirSync(join(wt, '.kilo'), { recursive: true })
      const original = '{"nested":true}'
      writeFileSync(join(wt, '.kilo', 'kilo.jsonc'), original)

      writeKiloConfig(wt)

      expect(existsSync(join(wt, 'kilo.jsonc'))).toBe(false)
      expect(readFileSync(join(wt, '.kilo', 'kilo.jsonc'), 'utf8')).toBe(original)
      const exclude = resolveInfoExclude(wt)
      const excludeContent = exclude && existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      expect(
        excludeContent
          .split('\n')
          .map((l) => l.trim())
          .includes('kilo.jsonc'),
      ).toBe(false)
    })
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
