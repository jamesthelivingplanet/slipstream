import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Exercises registerByUrl's clone destination against a REAL temp git repo.
 * `better-sqlite3` is built for Electron's ABI and cannot be instantiated
 * under plain node/vitest, so the DB DAO layer is mocked and a dummy db
 * handle (with just enough `prepare` support for backfillRemoteUrls) is
 * passed to createRepoRegistry.
 */

vi.mock('../db/db.js', () => ({
  upsertRepo: vi.fn(),
  allRepos: vi.fn(),
  getRepo: vi.fn(),
  deleteRepo: vi.fn(),
  getRepoSettings: vi.fn(),
  setRepoSettings: vi.fn(),
}))

import { createRepoRegistry } from './repoRegistry.js'
import { upsertRepo } from '../db/db.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

const dummyDb = {
  prepare: () => ({ all: () => [], run: () => {} }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

let scratch: string
let remoteUrl: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'slipstream-repo-'))

  // Upstream repo with one commit.
  const upstreamPath = join(scratch, 'upstream')
  execFileSync('git', ['init', '-b', 'main', upstreamPath], { encoding: 'utf8' })
  git(upstreamPath, 'config', 'user.email', 'test@slipstream.dev')
  git(upstreamPath, 'config', 'user.name', 'Slipstream Test')
  writeFileSync(join(upstreamPath, 'README.md'), '# widget\n')
  git(upstreamPath, 'add', '-A')
  git(upstreamPath, '-c', 'commit.gpgsign=false', 'commit', '-m', 'init')

  // Bare clone nested under acme/widget.git so parseOrgName derives
  // org "acme", name "widget", id "acme-widget".
  remoteUrl = join(scratch, 'acme', 'widget.git')
  execFileSync('git', ['clone', '--bare', upstreamPath, remoteUrl], { encoding: 'utf8' })

  vi.clearAllMocks()
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('repoRegistry.registerByUrl (real git)', () => {
  it('clones into <root>/.repositories/<id> and registers it', async () => {
    const registry = createRepoRegistry(dummyDb, scratch)
    const repo = await registry.registerByUrl(remoteUrl)

    const expectedPath = join(scratch, '.repositories', 'acme-widget')
    expect(repo.path).toBe(expectedPath)
    expect(repo.id).toBe('acme-widget')
    expect(existsSync(expectedPath)).toBe(true)
    expect(existsSync(join(expectedPath, '.git'))).toBe(true)
    expect(upsertRepo).toHaveBeenCalled()
  })

  it('reuses an existing managed clone instead of re-cloning', async () => {
    const registry = createRepoRegistry(dummyDb, scratch)
    const first = await registry.registerByUrl(remoteUrl)

    const markerPath = join(first.path, 'marker.txt')
    writeFileSync(markerPath, 'still here\n')

    const second = await registry.registerByUrl(remoteUrl)

    expect(second.path).toBe(first.path)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('rejects an empty/whitespace remote URL', async () => {
    const registry = createRepoRegistry(dummyDb, scratch)
    await expect(registry.registerByUrl('   ')).rejects.toThrow('Remote URL is required.')
  })
})
