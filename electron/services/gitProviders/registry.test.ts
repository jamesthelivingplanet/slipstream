import { describe, it, expect } from 'vitest'
import { GIT_PROVIDERS, providerFor, resolveRemote, resolvePrUrl } from './registry.js'
import type { GitHost } from '../../shared/contract.js'
import type { GitHostConfig } from './types.js'

function noCfg(): GitHostConfig {
  return {}
}

describe('GIT_PROVIDERS', () => {
  it('registers all four hosts with the expected metadata', () => {
    expect(GIT_PROVIDERS.map((p) => p.meta.id)).toEqual(['github', 'gitlab', 'bitbucket', 'gitea'])
  })

  it('bitbucket needs a username, gitea needs a base URL, github/gitlab need neither', () => {
    const byId = Object.fromEntries(GIT_PROVIDERS.map((p) => [p.meta.id, p.meta]))
    expect(byId.bitbucket).toMatchObject({ needsUsername: true, needsBaseUrl: false })
    expect(byId.gitea).toMatchObject({ needsUsername: false, needsBaseUrl: true })
    expect(byId.github).toMatchObject({ needsUsername: false, needsBaseUrl: false })
    expect(byId.gitlab).toMatchObject({ needsUsername: false, needsBaseUrl: false })
  })
})

describe('providerFor', () => {
  it('returns the provider for a known host', () => {
    expect(providerFor('github').meta.id).toBe('github')
    expect(providerFor('gitea').meta.id).toBe('gitea')
  })

  it('throws for an unregistered host', () => {
    expect(() => providerFor('notahost' as GitHost)).toThrow('Unknown git host')
  })
})

describe('resolveRemote', () => {
  it('picks github for a github.com remote (ssh and https)', () => {
    expect(resolveRemote('git@github.com:acme/api.git', noCfg)).toEqual({
      host: 'github',
      org: 'acme',
      name: 'api',
    })
    expect(resolveRemote('https://github.com/acme/api', noCfg)).toEqual({
      host: 'github',
      org: 'acme',
      name: 'api',
    })
  })

  it('picks gitlab for a gitlab.com remote', () => {
    expect(resolveRemote('git@gitlab.com:acme/api.git', noCfg)).toEqual({
      host: 'gitlab',
      org: 'acme',
      name: 'api',
    })
  })

  it('picks bitbucket for a bitbucket.org remote (fixed domain, no config needed)', () => {
    expect(resolveRemote('https://bitbucket.org/acme/api.git', noCfg)).toEqual({
      host: 'bitbucket',
      org: 'acme',
      name: 'api',
    })
  })

  it('returns null for an unknown domain', () => {
    expect(resolveRemote('https://git.example.com/acme/api.git', noCfg)).toBeNull()
  })

  it('gitea matches a self-hosted domain only via its configured baseUrl', () => {
    const getCfg = (host: GitHost): GitHostConfig =>
      host === 'gitea' ? { baseUrl: 'https://git.example.com' } : {}
    expect(resolveRemote('https://git.example.com/acme/api.git', getCfg)).toEqual({
      host: 'gitea',
      org: 'acme',
      name: 'api',
    })
    // …and a different domain still doesn't match, even with gitea configured.
    expect(resolveRemote('https://git.other.example/acme/api.git', getCfg)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(resolveRemote('not-a-url', noCfg)).toBeNull()
  })
})

describe('resolvePrUrl', () => {
  it('picks github for a github pull URL', () => {
    expect(resolvePrUrl('https://github.com/acme/api/pull/42', noCfg)).toEqual({
      host: 'github',
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('picks gitlab for a gitlab merge_requests URL', () => {
    expect(resolvePrUrl('https://gitlab.com/acme/api/-/merge_requests/7', noCfg)).toEqual({
      host: 'gitlab',
      org: 'acme',
      name: 'api',
      number: 7,
    })
  })

  it('returns null for an unknown host', () => {
    expect(resolvePrUrl('https://git.example.com/acme/api/pulls/1', noCfg)).toBeNull()
  })
})
