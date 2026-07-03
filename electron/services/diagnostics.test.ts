import { describe, it, expect } from 'vitest'
import { diagnoseRepos } from './diagnostics.js'
import type { RepoProbes } from './diagnostics.js'
import type { RepoDTO } from '../shared/contract.js'

function repo(overrides: Partial<RepoDTO> = {}): RepoDTO {
  return {
    id: 'acme-api',
    org: 'acme',
    name: 'api',
    base: 'main',
    path: '/repos/acme-api',
    ...overrides,
  }
}

function probes(overrides: Partial<RepoProbes> = {}): RepoProbes {
  return {
    exists: () => true,
    isWorktree: () => true,
    actualRemote: () => undefined,
    ...overrides,
  }
}

describe('diagnoseRepos', () => {
  it('flags a missing path', () => {
    const [d] = diagnoseRepos([repo()], probes({ exists: () => false, isWorktree: () => false }))
    expect(d.exists).toBe(false)
    expect(d.isWorktree).toBe(false)
  })

  it('flags a path that exists but is not a worktree', () => {
    const [d] = diagnoseRepos([repo()], probes({ exists: () => true, isWorktree: () => false }))
    expect(d.exists).toBe(true)
    expect(d.isWorktree).toBe(false)
  })

  it('reports isWorktree true for a valid git checkout', () => {
    const [d] = diagnoseRepos([repo()], probes({ isWorktree: () => true }))
    expect(d.isWorktree).toBe(true)
  })

  it('matches remotes that are identical', () => {
    const r = repo({ remoteUrl: 'git@github.com:acme/api.git' })
    const [d] = diagnoseRepos([r], probes({ actualRemote: () => 'git@github.com:acme/api.git' }))
    expect(d.remoteMatches).toBe(true)
  })

  it('normalizes a trailing .git and trailing slash before comparing', () => {
    const r = repo({ remoteUrl: 'https://github.com/acme/api.git' })
    const [d] = diagnoseRepos([r], probes({ actualRemote: () => 'https://github.com/acme/api/' }))
    expect(d.remoteMatches).toBe(true)
  })

  it('flags a genuine remote mismatch', () => {
    const r = repo({ remoteUrl: 'https://github.com/acme/api.git' })
    const [d] = diagnoseRepos(
      [r],
      probes({ actualRemote: () => 'https://github.com/other/api.git' }),
    )
    expect(d.remoteMatches).toBe(false)
    expect(d.configuredRemote).toBe('https://github.com/acme/api.git')
    expect(d.actualRemote).toBe('https://github.com/other/api.git')
  })

  it('treats both configured and actual remote absent as a match', () => {
    const r = repo({ remoteUrl: undefined })
    const [d] = diagnoseRepos([r], probes({ actualRemote: () => undefined }))
    expect(d.remoteMatches).toBe(true)
  })

  it('flags a mismatch when only one side has a remote', () => {
    const withConfigured = repo({ remoteUrl: 'https://github.com/acme/api.git' })
    const [d1] = diagnoseRepos([withConfigured], probes({ actualRemote: () => undefined }))
    expect(d1.remoteMatches).toBe(false)

    const withoutConfigured = repo({ remoteUrl: undefined })
    const [d2] = diagnoseRepos(
      [withoutConfigured],
      probes({ actualRemote: () => 'https://github.com/acme/api.git' }),
    )
    expect(d2.remoteMatches).toBe(false)
  })

  it('does not probe actualRemote when the path is not a worktree', () => {
    let called = false
    diagnoseRepos(
      [repo()],
      probes({
        isWorktree: () => false,
        actualRemote: () => {
          called = true
          return 'unexpected'
        },
      }),
    )
    expect(called).toBe(false)
  })
})
