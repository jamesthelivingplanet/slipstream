import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktreeManager } from './worktreeManager.js'
import type { RepoDTO } from '../shared/contract.js'

/**
 * Exercises the worktree lifecycle against a REAL temp git repo — the core of
 * the live "start agent" / "clean up" flow. No native modules, so it runs under
 * plain node/vitest.
 */
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

let root: string
let repo: RepoDTO
let wm: ReturnType<typeof createWorktreeManager>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'slipstream-wt-'))
  const repoPath = join(root, 'source')
  execFileSync('git', ['init', '-b', 'main', repoPath], { encoding: 'utf8' })
  git(repoPath, 'config', 'user.email', 'test@slipstream.dev')
  git(repoPath, 'config', 'user.name', 'Slipstream Test')
  writeFileSync(join(repoPath, 'README.md'), '# demo\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', 'init')

  repo = { id: 'acme-demo', org: 'acme', name: 'demo', base: 'main', path: repoPath }
  wm = createWorktreeManager(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('worktreeManager (real git)', () => {
  it('creates a worktree under .worktrees/<org>-<name>/<branch>, clean', async () => {
    const info = await wm.create(repo, 'feat-clean')
    expect(info.path).toBe(join(root, '.worktrees', 'acme-demo', 'feat-clean'))
    expect(existsSync(info.path)).toBe(true)
    expect(info.dirty).toBe(false)
    expect(info.ahead).toBe(0)
    expect(info.behind).toBe(0)
  })

  it('removes a clean, unmerged-free worktree without force', async () => {
    const res = await wm.remove(repo, 'feat-clean')
    expect(res.removed).toBe(true)
    expect(existsSync(join(root, '.worktrees', 'acme-demo', 'feat-clean'))).toBe(false)
  })

  it('create() is idempotent on an already-registered worktree', async () => {
    const info = await wm.create(repo, 'feat-reuse')
    const retry = await wm.create(repo, 'feat-reuse')
    expect(retry.path).toBe(info.path)
    expect(existsSync(info.path)).toBe(true)
    await wm.remove(repo, 'feat-reuse', { force: true })
  })

  it('create() checks out an existing branch whose worktree was removed', async () => {
    const first = await wm.create(repo, 'feat-rebranch')
    git(repo.path, 'worktree', 'remove', first.path)

    // branch ref still present after worktree removal
    const branchList = git(repo.path, 'branch', '--list', 'feat-rebranch')
    expect(branchList.trim()).not.toBe('')

    const retry = await wm.create(repo, 'feat-rebranch')
    expect(existsSync(retry.path)).toBe(true)
    await wm.remove(repo, 'feat-rebranch', { force: true })
  })

  it('detects a dirty worktree and refuses removal without force', async () => {
    const info = await wm.create(repo, 'feat-dirty')
    writeFileSync(join(info.path, 'scratch.txt'), 'uncommitted\n')

    const status = await wm.status(repo, 'feat-dirty')
    expect(status.dirty).toBe(true)

    const refused = await wm.remove(repo, 'feat-dirty')
    expect(refused.removed).toBe(false)
    expect(refused.reason).toMatch(/uncommitted/i)

    const forced = await wm.remove(repo, 'feat-dirty', { force: true })
    expect(forced.removed).toBe(true)
  })

  it('reports ahead count and refuses removal of an unmerged branch', async () => {
    const info = await wm.create(repo, 'feat-ahead')
    writeFileSync(join(info.path, 'feature.txt'), 'work\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'feature work')

    const status = await wm.status(repo, 'feat-ahead')
    expect(status.ahead).toBe(1)
    expect(status.dirty).toBe(false)

    const refused = await wm.remove(repo, 'feat-ahead')
    expect(refused.removed).toBe(false)
    expect(refused.reason).toMatch(/not merged/i)

    const forced = await wm.remove(repo, 'feat-ahead', { force: true })
    expect(forced.removed).toBe(true)
  })

  it('treats a squash-merged branch as merged and allows removal without force', async () => {
    const info = await wm.create(repo, 'feat-squash')
    writeFileSync(join(info.path, 'squash-a.txt'), 'first\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'first squash commit')
    writeFileSync(join(info.path, 'squash-b.txt'), 'second\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'second squash commit')

    // Squash-merge into base from the main repo checkout.
    git(repo.path, 'merge', '--squash', 'feat-squash')
    git(repo.path, 'commit', '-m', 'FLO-91: squashed feat-squash')

    const res = await wm.remove(repo, 'feat-squash')
    expect(res.removed).toBe(true)
  })

  it('isMerged: fresh branch with no commits is NOT merged (ahead 0)', async () => {
    await wm.create(repo, 'feat-m-fresh')
    const res = await wm.isMerged(repo, 'feat-m-fresh')
    expect(res.merged).toBe(false)
    expect(res.ahead).toBe(0)
    await wm.remove(repo, 'feat-m-fresh', { force: true })
  })

  it('isMerged: branch with open (unmerged) commits is NOT merged', async () => {
    const info = await wm.create(repo, 'feat-m-open')
    writeFileSync(join(info.path, 'open.txt'), 'wip\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'open work')

    const res = await wm.isMerged(repo, 'feat-m-open')
    expect(res.merged).toBe(false)
    expect(res.ahead).toBe(1)
    await wm.remove(repo, 'feat-m-open', { force: true })
  })

  it('isMerged: detects a GitLab-style merge commit naming the branch', async () => {
    const info = await wm.create(repo, 'feat-m-merge')
    writeFileSync(join(info.path, 'merged.txt'), 'work\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'merged work')

    git(
      repo.path,
      'merge',
      '--no-ff',
      '-m',
      "Merge branch 'feat-m-merge' into 'main'",
      'feat-m-merge',
    )

    const res = await wm.isMerged(repo, 'feat-m-merge')
    expect(res.merged).toBe(true)
    expect(res.via).toBe('merge-commit')
    await wm.remove(repo, 'feat-m-merge', { force: true })
  })

  it('isMerged: detects a Gitea/Forgejo-style merge commit ("... from <branch>")', async () => {
    const info = await wm.create(repo, 'feat-m-gitea')
    writeFileSync(join(info.path, 'gitea.txt'), 'work\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'gitea work')

    // Gitea/Forgejo subject shape: names the branch only after " from ",
    // without the GitLab quotes or the GitHub "<org>/" prefix.
    git(
      repo.path,
      'merge',
      '--no-ff',
      '-m',
      "Merge pull request 'add the gitea thing' (#12) from feat-m-gitea",
      'feat-m-gitea',
    )

    const res = await wm.isMerged(repo, 'feat-m-gitea')
    expect(res.merged).toBe(true)
    expect(res.via).toBe('merge-commit')
    await wm.remove(repo, 'feat-m-gitea', { force: true })
  })

  it('isMerged: detects a Bitbucket-style merge commit ("Merged in <branch> (pull request #N)")', async () => {
    const info = await wm.create(repo, 'feat-m-bb')
    writeFileSync(join(info.path, 'bb.txt'), 'work\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'bitbucket work')

    git(repo.path, 'merge', '--no-ff', '-m', 'Merged in feat-m-bb (pull request #7)', 'feat-m-bb')

    const res = await wm.isMerged(repo, 'feat-m-bb')
    expect(res.merged).toBe(true)
    expect(res.via).toBe('merge-commit')
    await wm.remove(repo, 'feat-m-bb', { force: true })
  })

  it('isMerged: detects a squash merge whose commit does not name the branch', async () => {
    const info = await wm.create(repo, 'feat-m-squash')
    writeFileSync(join(info.path, 'sq-a.txt'), 'a\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'squash part one')
    writeFileSync(join(info.path, 'sq-b.txt'), 'b\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'squash part two')

    git(repo.path, 'merge', '--squash', 'feat-m-squash')
    git(repo.path, 'commit', '-m', 'T-42: landed the thing') // no branch name anywhere

    const res = await wm.isMerged(repo, 'feat-m-squash')
    expect(res.merged).toBe(true)
    expect(res.via).toBe('squash')
    await wm.remove(repo, 'feat-m-squash', { force: true })
  })

  it('isMerged: missing branch ref reports ahead -1, not merged', async () => {
    const res = await wm.isMerged(repo, 'no-such-branch')
    expect(res).toEqual({ merged: false, ahead: -1 })
  })

  it('removes worktree, prunes stale entries, and deletes the branch', async () => {
    await wm.create(repo, 'feat-teardown')
    const wtPath = join(root, '.worktrees', 'acme-demo', 'feat-teardown')
    expect(existsSync(wtPath)).toBe(true)

    const res = await wm.remove(repo, 'feat-teardown')
    expect(res.removed).toBe(true)

    // worktree dir no longer exists
    expect(existsSync(wtPath)).toBe(false)

    // branch is gone
    const branchList = git(repo.path, 'branch', '--list', 'feat-teardown')
    expect(branchList.trim()).toBe('')

    // worktree list does not contain feat-teardown
    const worktreeList = git(repo.path, 'worktree', 'list')
    expect(worktreeList).not.toContain('feat-teardown')
  })

  it('lists active worktrees (excluding the main checkout)', async () => {
    await wm.create(repo, 'feat-list')
    const list = await wm.list(repo)
    expect(list.some((w) => w.branch === 'feat-list')).toBe(true)
    expect(list.some((w) => w.path === repo.path)).toBe(false)
    // The primary checkout's stanza must be skipped entirely — no bogus entry
    // for the base branch pointing at a .worktrees path that doesn't exist.
    expect(list.some((w) => w.branch === repo.base)).toBe(false)
    for (const w of list) expect(existsSync(w.path)).toBe(true)
    await wm.remove(repo, 'feat-list', { force: true })
  })

  it('reports added/deleted > 0 after committing changes in a worktree', async () => {
    const info = await wm.create(repo, 'feat-diffstat')
    writeFileSync(join(info.path, 'newfile.txt'), 'hello\nworld\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'add newfile')

    const status = await wm.status(repo, 'feat-diffstat')
    expect(status.added).toBeGreaterThan(0)

    await wm.remove(repo, 'feat-diffstat', { force: true })
  })

  it('removes gracefully when the worktree directory was deleted out-of-band (detached agent)', async () => {
    await wm.create(repo, 'feat-detached')
    const wtPath = join(root, '.worktrees', 'acme-demo', 'feat-detached')
    rmSync(wtPath, { recursive: true, force: true })

    const res = await wm.remove(repo, 'feat-detached')
    expect(res.removed).toBe(true)

    const branchList = git(repo.path, 'branch', '--list', 'feat-detached')
    expect(branchList.trim()).toBe('')

    const worktreeList = git(repo.path, 'worktree', 'list')
    expect(worktreeList).not.toContain('feat-detached')
  })

  it('remove is idempotent — a second remove of an already-gone worktree still succeeds', async () => {
    await wm.create(repo, 'feat-idem')
    await wm.remove(repo, 'feat-idem')

    const res = await wm.remove(repo, 'feat-idem')
    expect(res.removed).toBe(true)
  })

  it('status() returns +0/-0 without throwing for a missing worktree', async () => {
    await wm.create(repo, 'feat-missingstat')
    const wtPath = join(root, '.worktrees', 'acme-demo', 'feat-missingstat')
    rmSync(wtPath, { recursive: true, force: true })

    const st = await wm.status(repo, 'feat-missingstat')
    expect(st.added).toBe(0)
    expect(st.deleted).toBe(0)

    await wm.remove(repo, 'feat-missingstat', { force: true })
  })
})

describe('worktreeManager pull-before-create (real git + remote)', () => {
  let rroot: string
  let rrepo: RepoDTO
  let rwm: ReturnType<typeof createWorktreeManager>

  beforeAll(() => {
    rroot = mkdtempSync(join(tmpdir(), 'slipstream-wt-remote-'))
    const remotePath = join(rroot, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', remotePath], { encoding: 'utf8' })

    // First clone seeds the remote with an initial commit.
    const seedPath = join(rroot, 'seed')
    execFileSync('git', ['clone', remotePath, seedPath], { encoding: 'utf8' })
    git(seedPath, 'config', 'user.email', 'test@slipstream.dev')
    git(seedPath, 'config', 'user.name', 'Slipstream Test')
    writeFileSync(join(seedPath, 'README.md'), '# demo\n')
    git(seedPath, 'add', '-A')
    git(seedPath, 'commit', '-m', 'init')
    git(seedPath, 'push', 'origin', 'main')

    // The repo the app manages — clone it now, while origin/main is at "init".
    const repoPath = join(rroot, 'source')
    execFileSync('git', ['clone', remotePath, repoPath], { encoding: 'utf8' })
    git(repoPath, 'config', 'user.email', 'test@slipstream.dev')
    git(repoPath, 'config', 'user.name', 'Slipstream Test')

    // Someone else advances origin/main AFTER source was cloned, so source's
    // local main is now stale.
    writeFileSync(join(seedPath, 'remote-feature.txt'), 'from remote\n')
    git(seedPath, 'add', '-A')
    git(seedPath, 'commit', '-m', 'remote feature')
    git(seedPath, 'push', 'origin', 'main')

    rrepo = { id: 'acme-remote', org: 'acme', name: 'remote', base: 'main', path: repoPath }
    rwm = createWorktreeManager(rroot)
  })

  afterAll(() => {
    rmSync(rroot, { recursive: true, force: true })
  })

  it('cuts a new branch from the latest remote base (pulls first)', async () => {
    // source's local main does NOT have remote-feature.txt yet.
    const info = await rwm.create(rrepo, 'feat-fresh')
    // The new worktree must include the commit that only exists on origin/main.
    expect(existsSync(join(info.path, 'remote-feature.txt'))).toBe(true)
    await rwm.remove(rrepo, 'feat-fresh', { force: true })
  })
})

describe('worktreeManager.diff (real git)', () => {
  let droot: string
  let drepo: RepoDTO
  let dwm: ReturnType<typeof createWorktreeManager>

  beforeAll(() => {
    droot = mkdtempSync(join(tmpdir(), 'slipstream-wt-diff-'))
    const repoPath = join(droot, 'source')
    execFileSync('git', ['init', '-b', 'main', repoPath], { encoding: 'utf8' })
    git(repoPath, 'config', 'user.email', 'test@slipstream.dev')
    git(repoPath, 'config', 'user.name', 'Slipstream Test')
    // Regression guard (FLO-138): turn ON mnemonic diff prefixes here so this
    // suite exercises the c// w// path on every machine, regardless of the
    // developer's global git config. worktreeManager.diff must force
    // diff.mnemonicprefix=false itself, so the parsed paths stay canonical.
    git(repoPath, 'config', 'diff.mnemonicprefix', 'true')
    writeFileSync(join(repoPath, 'README.md'), 'line one\nline two\nline three\n')
    writeFileSync(join(repoPath, 'to-delete.txt'), 'will be removed\n')
    git(repoPath, 'add', '-A')
    git(repoPath, 'commit', '-m', 'init')

    drepo = { id: 'acme-diff', org: 'acme', name: 'diff', base: 'main', path: repoPath }
    dwm = createWorktreeManager(droot)
  })

  afterAll(() => {
    rmSync(droot, { recursive: true, force: true })
  })

  it('reports modified/added/deleted/untracked statuses with correct hunk line numbers', async () => {
    const info = await dwm.create(drepo, 'feat-diffreview')
    const wtPath = info.path

    // committed add
    writeFileSync(join(wtPath, 'added.txt'), 'new file line 1\nnew file line 2\n')
    git(wtPath, 'add', 'added.txt')
    git(wtPath, 'commit', '-m', 'add added.txt')

    // uncommitted modification of a tracked file
    writeFileSync(join(wtPath, 'README.md'), 'line one\nline TWO changed\nline three\n')

    // uncommitted deletion of a tracked file
    rmSync(join(wtPath, 'to-delete.txt'))

    // untracked file
    writeFileSync(join(wtPath, 'scratch.txt'), 'untracked contents\n')

    const dto = await dwm.diff(drepo, 'feat-diffreview')

    expect(dto.error).toBeUndefined()
    expect(dto.branch).toBe('feat-diffreview')
    expect(dto.base).toBe('main')
    expect(dto.mergeBase).toMatch(/^[0-9a-f]{40}$/)
    expect(dto.truncated).toBe(false)

    const byPath = Object.fromEntries(dto.files.map((f) => [f.path, f]))

    expect(byPath['added.txt'].status).toBe('added')
    expect(byPath['added.txt'].additions).toBe(2)
    expect(byPath['added.txt'].deletions).toBe(0)

    expect(byPath['README.md'].status).toBe('modified')
    const readmeLines = byPath['README.md'].hunks[0].lines
    const del = readmeLines.find((l) => l.kind === 'del')
    const add = readmeLines.find((l) => l.kind === 'add')
    expect(del).toMatchObject({ text: 'line two', oldLine: 2, newLine: null })
    expect(add).toMatchObject({ text: 'line TWO changed', oldLine: null, newLine: 2 })
    const lastContext = readmeLines[readmeLines.length - 1]
    expect(lastContext).toMatchObject({
      kind: 'context',
      text: 'line three',
      oldLine: 3,
      newLine: 3,
    })

    expect(byPath['to-delete.txt'].status).toBe('deleted')
    expect(byPath['to-delete.txt'].deletions).toBe(1)
    expect(byPath['to-delete.txt'].additions).toBe(0)

    expect(byPath['scratch.txt'].status).toBe('untracked')
    expect(byPath['scratch.txt'].hunks[0]?.lines[0]).toMatchObject({
      kind: 'add',
      text: 'untracked contents',
      newLine: 1,
    })

    await dwm.remove(drepo, 'feat-diffreview', { force: true })
  })

  it('returns an error DTO (not a throw) for a nonexistent worktree', async () => {
    const dto = await dwm.diff(drepo, 'does-not-exist-branch')
    expect(dto.error).toBeTruthy()
    expect(dto.files).toEqual([])
    expect(dto.truncated).toBe(false)
    expect(dto.mergeBase).toBe('')
    expect(dto.branch).toBe('does-not-exist-branch')
    expect(dto.base).toBe('main')
  })
})

describe('worktreeManager.updateFromBase (real git)', () => {
  let uroot: string
  let urepo: RepoDTO
  let uwm: ReturnType<typeof createWorktreeManager>

  beforeAll(() => {
    uroot = mkdtempSync(join(tmpdir(), 'slipstream-wt-update-'))
    const repoPath = join(uroot, 'source')
    execFileSync('git', ['init', '-b', 'main', repoPath], { encoding: 'utf8' })
    git(repoPath, 'config', 'user.email', 'test@slipstream.dev')
    git(repoPath, 'config', 'user.name', 'Slipstream Test')
    writeFileSync(join(repoPath, 'README.md'), 'line one\n')
    git(repoPath, 'add', '-A')
    git(repoPath, 'commit', '-m', 'init')

    urepo = { id: 'acme-update', org: 'acme', name: 'update', base: 'main', path: repoPath }
    uwm = createWorktreeManager(uroot)
  })

  afterAll(() => {
    rmSync(uroot, { recursive: true, force: true })
  })

  it('clean rebase: worktree behind base ends up linear and not behind', async () => {
    const info = await uwm.create(urepo, 'feat-rebase-clean')

    // advance base
    writeFileSync(join(urepo.path, 'base-advance-1.txt'), 'advance\n')
    git(urepo.path, 'add', '-A')
    git(urepo.path, 'commit', '-m', 'advance base')

    const result = await uwm.updateFromBase(urepo, 'feat-rebase-clean', { mode: 'rebase' })
    expect(result.updated).toBe(true)
    expect(result.info?.behind).toBe(0)
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'feat-rebase-clean'], {
        cwd: info.path,
      }),
    ).not.toThrow()

    await uwm.remove(urepo, 'feat-rebase-clean', { force: true })
  })

  it('rebase preserves branch commits on top of the advanced base', async () => {
    const info = await uwm.create(urepo, 'feat-rebase-preserve')
    writeFileSync(join(info.path, 'own-commit.txt'), 'mine\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'own work')

    writeFileSync(join(urepo.path, 'base-advance-2.txt'), 'advance\n')
    git(urepo.path, 'add', '-A')
    git(urepo.path, 'commit', '-m', 'advance base again')

    const result = await uwm.updateFromBase(urepo, 'feat-rebase-preserve', { mode: 'rebase' })
    expect(result.updated).toBe(true)
    expect(result.info?.ahead).toBeGreaterThanOrEqual(1)
    expect(result.info?.behind).toBe(0)

    await uwm.remove(urepo, 'feat-rebase-preserve', { force: true })
  })

  it('clean merge: creates a merge commit and is no longer behind', async () => {
    const info = await uwm.create(urepo, 'feat-merge-clean')
    // A branch-local commit is required so the merge can't fast-forward.
    writeFileSync(join(info.path, 'own-merge-commit.txt'), 'mine\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'own work before merge')

    writeFileSync(join(urepo.path, 'base-advance-3.txt'), 'advance\n')
    git(urepo.path, 'add', '-A')
    git(urepo.path, 'commit', '-m', 'advance base for merge')

    const result = await uwm.updateFromBase(urepo, 'feat-merge-clean', { mode: 'merge' })
    expect(result.updated).toBe(true)
    expect(result.info?.behind).toBe(0)
    expect(() =>
      execFileSync('git', ['rev-parse', 'HEAD^2'], { cwd: info.path, encoding: 'utf8' }),
    ).not.toThrow()

    await uwm.remove(urepo, 'feat-merge-clean', { force: true })
  })

  it('rebase conflict aborts and restores the worktree untouched', async () => {
    const info = await uwm.create(urepo, 'feat-rebase-conflict')
    writeFileSync(join(info.path, 'README.md'), 'branch change\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'branch edits README')

    writeFileSync(join(urepo.path, 'README.md'), 'base change\n')
    git(urepo.path, 'add', '-A')
    git(urepo.path, 'commit', '-m', 'base edits README')

    const shaBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: info.path,
      encoding: 'utf8',
    }).trim()
    const porcelainBefore = execFileSync('git', ['status', '--porcelain'], {
      cwd: info.path,
      encoding: 'utf8',
    })

    const result = await uwm.updateFromBase(urepo, 'feat-rebase-conflict', { mode: 'rebase' })
    expect(result.updated).toBe(false)
    expect(result.conflicted).toBe(true)

    const shaAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: info.path,
      encoding: 'utf8',
    }).trim()
    const porcelainAfter = execFileSync('git', ['status', '--porcelain'], {
      cwd: info.path,
      encoding: 'utf8',
    })
    expect(shaAfter).toBe(shaBefore)
    expect(porcelainAfter).toBe(porcelainBefore)

    // no rebase in progress
    expect(() =>
      execFileSync('git', ['rebase', '--abort'], { cwd: info.path, encoding: 'utf8' }),
    ).toThrow()

    await uwm.remove(urepo, 'feat-rebase-conflict', { force: true })
  })

  it('merge conflict aborts and leaves no MERGE_HEAD', async () => {
    const info = await uwm.create(urepo, 'feat-merge-conflict')
    writeFileSync(join(info.path, 'README.md'), 'branch change v2\n')
    git(info.path, 'add', '-A')
    git(info.path, 'commit', '-m', 'branch edits README v2')

    writeFileSync(join(urepo.path, 'README.md'), 'base change v2\n')
    git(urepo.path, 'add', '-A')
    git(urepo.path, 'commit', '-m', 'base edits README v2')

    const result = await uwm.updateFromBase(urepo, 'feat-merge-conflict', { mode: 'merge' })
    expect(result.updated).toBe(false)
    expect(result.conflicted).toBe(true)

    expect(() =>
      execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
        cwd: info.path,
        encoding: 'utf8',
      }),
    ).toThrow()

    await uwm.remove(urepo, 'feat-merge-conflict', { force: true })
  })

  it('dirty worktree: uncommitted edit to an untouched file survives via autostash', async () => {
    const info = await uwm.create(urepo, 'feat-rebase-dirty')

    writeFileSync(join(urepo.path, 'base-advance-4.txt'), 'advance\n')
    git(urepo.path, 'add', '-A')
    git(urepo.path, 'commit', '-m', 'advance base for dirty test')

    writeFileSync(join(info.path, 'untouched-by-base.txt'), 'my uncommitted work\n')

    const result = await uwm.updateFromBase(urepo, 'feat-rebase-dirty', { mode: 'rebase' })
    expect(result.updated).toBe(true)
    expect(result.stashSaved).toBeFalsy()
    expect(result.info?.dirty).toBe(true)

    const content = readFileSync(join(info.path, 'untouched-by-base.txt'), 'utf8')
    expect(content).toBe('my uncommitted work\n')

    await uwm.remove(urepo, 'feat-rebase-dirty', { force: true })
  })

  it('missing worktree: returns updated false with a "missing" reason', async () => {
    const result = await uwm.updateFromBase(urepo, 'feat-never-created', { mode: 'rebase' })
    expect(result.updated).toBe(false)
    expect(result.reason).toMatch(/missing/i)
  })

  it('already up to date: still succeeds as a no-op', async () => {
    await uwm.create(urepo, 'feat-uptodate')
    const result = await uwm.updateFromBase(urepo, 'feat-uptodate', { mode: 'rebase' })
    expect(result.updated).toBe(true)
    expect(result.info?.behind).toBe(0)

    await uwm.remove(urepo, 'feat-uptodate', { force: true })
  })
})
