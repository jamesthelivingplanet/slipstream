import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, renameSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveRepoPath,
  getRemoteUrl,
  isWorkTree,
  findSiblingCheckout,
  cloneRepo,
  assertAllowedRemoteUrl,
} from './repoResolve.js'
import type { RepoDTO } from '../shared/contract.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'slipstream-resolve-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function initRepo(path: string, remote: string): void {
  execFileSync('git', ['init', '-b', 'main', path], { encoding: 'utf8' })
  git(path, 'config', 'user.email', 'test@slipstream.dev')
  git(path, 'config', 'user.name', 'Slipstream Test')
  writeFileSync(join(path, 'README.md'), '# demo\n')
  git(path, 'add', '-A')
  git(path, 'commit', '-m', 'init')
  git(path, 'remote', 'add', 'origin', remote)
}

describe('repoResolve helpers', () => {
  it('getRemoteUrl returns the origin url for a repo with a remote', () => {
    const p = join(root, 'has-remote')
    initRepo(p, 'https://github.com/acme/api.git')
    expect(getRemoteUrl(p)).toBe('https://github.com/acme/api.git')
  })

  it('getRemoteUrl returns null for a missing path', () => {
    expect(getRemoteUrl(join(root, 'does-not-exist'))).toBeNull()
  })

  it('isWorkTree is true for a real checkout and false for a missing path', () => {
    const p = join(root, 'is-a-repo')
    initRepo(p, 'https://github.com/acme/is.git')
    expect(isWorkTree(p)).toBe(true)
    expect(isWorkTree(join(root, 'nope'))).toBe(false)
  })
})

describe('resolveRepoPath', () => {
  it('fast-path: returns the repo unchanged when the stored path is still valid and remote matches', () => {
    const p = join(root, 'stable')
    initRepo(p, 'https://github.com/acme/stable.git')
    const repo: RepoDTO = {
      id: 'acme-stable',
      org: 'acme',
      name: 'stable',
      base: 'main',
      path: p,
      remoteUrl: 'https://github.com/acme/stable.git',
    }
    const result = resolveRepoPath(repo)
    expect(result).not.toBeNull()
    expect(result!.healed).toBe(false)
    expect(result!.repo.path).toBe(p)
  })

  it('self-heals when the checkout dir was renamed (flotilla -> slipstream case)', () => {
    const parent = join(root, 'rename-parent')
    const oldPath = join(parent, 'flotilla')
    mkdirSync(parent, { recursive: true })
    initRepo(oldPath, 'https://github.com/ajlebaron/slipstream.git')
    const newPath = join(parent, 'slipstream')
    renameSync(oldPath, newPath)

    const repo: RepoDTO = {
      id: 'ajlebaron-slipstream',
      org: 'ajlebaron',
      name: 'slipstream',
      base: 'main',
      path: oldPath,
      remoteUrl: 'https://github.com/ajlebaron/slipstream.git',
    }
    const result = resolveRepoPath(repo)
    expect(result).not.toBeNull()
    expect(result!.healed).toBe(true)
    expect(result!.repo.path).toBe(newPath)
  })

  it('findSiblingCheckout locates a sibling with the matching remote', () => {
    const parent = join(root, 'sibling-parent')
    mkdirSync(parent, { recursive: true })
    const a = join(parent, 'a')
    initRepo(a, 'https://github.com/acme/seek.git')
    const staleStored = join(parent, 'gone')
    expect(findSiblingCheckout('https://github.com/acme/seek.git', staleStored)).toBe(a)
  })

  it('returns null (clear error upstream) when the dir is deleted and no sibling matches', () => {
    const parent = join(root, 'deleted-parent')
    mkdirSync(parent, { recursive: true })
    const gone = join(parent, 'gone-repo')
    initRepo(gone, 'https://github.com/acme/gone.git')
    rmSync(gone, { recursive: true, force: true })

    const repo: RepoDTO = {
      id: 'acme-gone',
      org: 'acme',
      name: 'gone',
      base: 'main',
      path: gone,
      remoteUrl: 'https://github.com/acme/gone.git',
    }
    const result = resolveRepoPath(repo)
    expect(result).toBeNull()
  })
})

describe('cloneRepo', () => {
  it('clones a local repo into dest and makes it a work tree with the correct remote', async () => {
    const src = join(root, 'clone-src')
    initRepo(src, 'https://github.com/acme/cloned.git')
    const dest = join(root, 'clone-dest')
    await cloneRepo(src, dest)
    expect(isWorkTree(dest)).toBe(true)
    expect(getRemoteUrl(dest)).toBe(src)
  })

  it('rejects with a clear Error when given a bogus path', async () => {
    const bad = join(root, 'does-not-exist-at-all')
    const dest = join(root, 'clone-bad-dest')
    await expect(cloneRepo(bad, dest)).rejects.toThrow(/Failed to clone/)
  })

  it('rejects ext:: without ever invoking the shell command', async () => {
    const marker = join(root, 'pwned-marker')
    const dest = join(root, 'clone-ext-dest')
    await expect(cloneRepo(`ext::sh -c "touch ${marker}"`, dest)).rejects.toThrow(
      /Unsupported git remote URL scheme "ext:"/,
    )
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects file:// URLs', async () => {
    const dest = join(root, 'clone-file-dest')
    await expect(cloneRepo(`file://${root}/clone-src`, dest)).rejects.toThrow(
      /Unsupported git remote URL scheme "file:"/,
    )
  })
})

describe('assertAllowedRemoteUrl', () => {
  it('allows https and ssh URLs', () => {
    expect(() => assertAllowedRemoteUrl('https://github.com/acme/api.git')).not.toThrow()
    expect(() => assertAllowedRemoteUrl('ssh://git@github.com/acme/api.git')).not.toThrow()
  })

  it('allows scp-like ssh syntax', () => {
    expect(() => assertAllowedRemoteUrl('git@github.com:acme/api.git')).not.toThrow()
  })

  it('allows a bare local filesystem path', () => {
    expect(() => assertAllowedRemoteUrl('/tmp/some/repo.git')).not.toThrow()
  })

  it('rejects ext:: (arbitrary command execution via the remote helper)', () => {
    expect(() => assertAllowedRemoteUrl('ext::sh -c "touch /tmp/pwned"')).toThrow(
      /Unsupported git remote URL scheme "ext:"/,
    )
  })

  it('rejects file:// URLs', () => {
    expect(() => assertAllowedRemoteUrl('file:///etc/passwd')).toThrow(
      /Unsupported git remote URL scheme "file:"/,
    )
  })

  it('rejects other unlisted schemes', () => {
    expect(() => assertAllowedRemoteUrl('git://github.com/acme/api.git')).toThrow(
      /Unsupported git remote URL scheme "git:"/,
    )
  })

  it('rejects a leading dash (option/flag injection)', () => {
    expect(() => assertAllowedRemoteUrl('-oProxyCommand=touch /tmp/pwned')).toThrow(
      /Unsupported git remote URL/,
    )
  })

  it('rejects an allowed scheme name used with double-colon remote-helper syntax', () => {
    expect(() => assertAllowedRemoteUrl('https::sh -c "touch /tmp/pwned"')).toThrow(
      /Unsupported git remote URL scheme "https:"/,
    )
  })
})
