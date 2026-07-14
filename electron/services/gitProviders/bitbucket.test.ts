import { describe, it, expect, vi } from 'vitest'
import {
  bitbucket,
  matchBitbucketRemote,
  matchBitbucketPrUrl,
  buildBitbucketAuthPushUrl,
  basicAuthHeader,
  buildBitbucketFindPrDescriptor,
  buildBitbucketCreatePrDescriptor,
  mapBitbucketPrState,
  mapBitbucketReviews,
  aggregateBitbucketStatuses,
} from './bitbucket.js'
import type { GitHostConfig } from './types.js'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('matchBitbucketRemote', () => {
  it('matches an ssh remote', () => {
    expect(matchBitbucketRemote('git@bitbucket.org:acme/api.git')).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an ssh remote without .git suffix', () => {
    expect(matchBitbucketRemote('git@bitbucket.org:acme/api')).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches a plain https remote', () => {
    expect(matchBitbucketRemote('https://bitbucket.org/acme/api.git')).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an https remote without .git suffix', () => {
    expect(matchBitbucketRemote('https://bitbucket.org/acme/api')).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an https remote with embedded userinfo', () => {
    expect(matchBitbucketRemote('https://someuser@bitbucket.org/acme/api.git')).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('returns null for a github ssh remote', () => {
    expect(matchBitbucketRemote('git@github.com:acme/api.git')).toBeNull()
  })

  it('returns null for a github https remote', () => {
    expect(matchBitbucketRemote('https://github.com/acme/api.git')).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(matchBitbucketRemote('not-a-remote')).toBeNull()
  })
})

describe('matchBitbucketPrUrl', () => {
  it('parses a bitbucket pull request url', () => {
    expect(matchBitbucketPrUrl('https://bitbucket.org/acme/api/pull-requests/42')).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('tolerates a trailing slash', () => {
    expect(matchBitbucketPrUrl('https://bitbucket.org/acme/api/pull-requests/42/')).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('tolerates extra path segments after the number', () => {
    expect(matchBitbucketPrUrl('https://bitbucket.org/acme/api/pull-requests/42/diff')).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('returns null for a github pull url', () => {
    expect(matchBitbucketPrUrl('https://github.com/acme/api/pull/42')).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(matchBitbucketPrUrl('not-a-url')).toBeNull()
  })
})

describe('buildBitbucketAuthPushUrl', () => {
  it('builds an authenticated push url with username and token url-encoded', () => {
    const cfg: GitHostConfig = { username: 'me@example.com', token: 'p@ss/word' }
    expect(
      buildBitbucketAuthPushUrl('https://bitbucket.org/acme/api.git', 'acme', 'api', cfg),
    ).toBe(
      `https://${encodeURIComponent('me@example.com')}:${encodeURIComponent('p@ss/word')}@bitbucket.org/acme/api.git`,
    )
  })

  it('returns null when the username is missing', () => {
    const cfg: GitHostConfig = { token: 'tok' }
    expect(
      buildBitbucketAuthPushUrl('https://bitbucket.org/acme/api.git', 'acme', 'api', cfg),
    ).toBeNull()
  })

  it('returns null when the token is missing', () => {
    const cfg: GitHostConfig = { username: 'me' }
    expect(
      buildBitbucketAuthPushUrl('https://bitbucket.org/acme/api.git', 'acme', 'api', cfg),
    ).toBeNull()
  })

  it('returns null for an ssh remote even with full config', () => {
    const cfg: GitHostConfig = { username: 'me', token: 'tok' }
    expect(
      buildBitbucketAuthPushUrl('git@bitbucket.org:acme/api.git', 'acme', 'api', cfg),
    ).toBeNull()
  })
})

describe('basicAuthHeader', () => {
  it('base64-encodes username:token', () => {
    expect(basicAuthHeader('me', 'secret')).toBe(
      `Basic ${Buffer.from('me:secret').toString('base64')}`,
    )
  })
})

describe('buildBitbucketFindPrDescriptor', () => {
  it('builds a GET request with the source-branch/open-state query and basic auth', () => {
    const desc = buildBitbucketFindPrDescriptor({
      org: 'acme',
      name: 'api',
      branch: 'feature/x',
      username: 'me',
      token: 'tok',
    })
    expect(desc.method).toBe('GET')
    expect(desc.url).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests?q=' +
        encodeURIComponent('source.branch.name = "feature/x" AND state = "OPEN"'),
    )
    expect(desc.headers.Authorization).toBe(basicAuthHeader('me', 'tok'))
  })
})

describe('buildBitbucketCreatePrDescriptor', () => {
  it('builds a POST request with the pullrequests body and basic auth', () => {
    const desc = buildBitbucketCreatePrDescriptor({
      org: 'acme',
      name: 'api',
      branch: 'feature/x',
      base: 'main',
      title: 'My PR',
      body: 'Description',
      username: 'me',
      token: 'tok',
    })
    expect(desc.method).toBe('POST')
    expect(desc.url).toBe('https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests')
    expect(desc.headers.Authorization).toBe(basicAuthHeader('me', 'tok'))
    expect(JSON.parse(desc.body)).toEqual({
      title: 'My PR',
      description: 'Description',
      source: { branch: { name: 'feature/x' } },
      destination: { branch: { name: 'main' } },
    })
  })
})

describe('mapBitbucketPrState', () => {
  it('maps OPEN to open', () => {
    expect(mapBitbucketPrState('OPEN')).toBe('open')
  })
  it('maps MERGED to merged', () => {
    expect(mapBitbucketPrState('MERGED')).toBe('merged')
  })
  it('maps DECLINED to closed', () => {
    expect(mapBitbucketPrState('DECLINED')).toBe('closed')
  })
  it('maps SUPERSEDED to closed', () => {
    expect(mapBitbucketPrState('SUPERSEDED')).toBe('closed')
  })
  it('maps anything else to unknown', () => {
    expect(mapBitbucketPrState('WEIRD')).toBe('unknown')
  })
})

describe('mapBitbucketReviews', () => {
  it('returns none with zero approvals for no participants', () => {
    expect(mapBitbucketReviews([])).toEqual({ review: 'none', approvals: 0 })
  })

  it('returns approved with a count when participants approved and none requested changes', () => {
    expect(
      mapBitbucketReviews([
        { approved: true, state: 'approved' },
        { approved: true, state: 'approved' },
        { approved: false, state: null },
      ]),
    ).toEqual({ review: 'approved', approvals: 2 })
  })

  it('returns changes_requested when any participant requested changes, even if others approved', () => {
    expect(
      mapBitbucketReviews([
        { approved: true, state: 'approved' },
        { approved: false, state: 'changes_requested' },
      ]),
    ).toEqual({ review: 'changes_requested', approvals: 1 })
  })

  it('returns none when no one has approved or requested changes', () => {
    expect(mapBitbucketReviews([{ approved: false, state: null }])).toEqual({
      review: 'none',
      approvals: 0,
    })
  })
})

describe('aggregateBitbucketStatuses', () => {
  it('returns none for an empty list', () => {
    expect(aggregateBitbucketStatuses([])).toBe('none')
  })

  it('returns running when any status is INPROGRESS', () => {
    expect(aggregateBitbucketStatuses([{ state: 'SUCCESSFUL' }, { state: 'INPROGRESS' }])).toBe(
      'running',
    )
  })

  it('returns failed when any status is FAILED', () => {
    expect(aggregateBitbucketStatuses([{ state: 'SUCCESSFUL' }, { state: 'FAILED' }])).toBe(
      'failed',
    )
  })

  it('returns failed when any status is STOPPED', () => {
    expect(aggregateBitbucketStatuses([{ state: 'SUCCESSFUL' }, { state: 'STOPPED' }])).toBe(
      'failed',
    )
  })

  it('prioritizes running over failed when both are present', () => {
    expect(aggregateBitbucketStatuses([{ state: 'FAILED' }, { state: 'INPROGRESS' }])).toBe(
      'running',
    )
  })

  it('returns passed when all statuses are SUCCESSFUL', () => {
    expect(aggregateBitbucketStatuses([{ state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }])).toBe(
      'passed',
    )
  })
})

describe('bitbucket.meta', () => {
  it('keeps the stub metadata', () => {
    expect(bitbucket.meta).toEqual({
      id: 'bitbucket',
      displayName: 'Bitbucket',
      tokenHint: 'App password with repository:write and pullrequest:write scopes.',
      needsUsername: true,
      needsBaseUrl: false,
    })
  })
})

describe('bitbucket.openMergeRequest', () => {
  const cfg: GitHostConfig = { username: 'me', token: 'tok' }

  it('throws when username is missing', async () => {
    await expect(
      bitbucket.openMergeRequest({
        org: 'acme',
        name: 'api',
        branch: 'feature/x',
        base: 'main',
        title: 't',
        body: 'b',
        cfg: { token: 'tok' },
        fetchFn: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Bitbucket requires a username and app password/)
  })

  it('throws when token is missing', async () => {
    await expect(
      bitbucket.openMergeRequest({
        org: 'acme',
        name: 'api',
        branch: 'feature/x',
        base: 'main',
        title: 't',
        body: 'b',
        cfg: { username: 'me' },
        fetchFn: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Bitbucket requires a username and app password/)
  })

  it('returns the existing PR when one is already open for the branch', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain('/repositories/acme/api/pullrequests?q=')
      return jsonResponse({
        values: [{ links: { html: { href: 'https://bitbucket.org/acme/api/pull-requests/5' } } }],
      })
    })
    const result = await bitbucket.openMergeRequest({
      org: 'acme',
      name: 'api',
      branch: 'feature/x',
      base: 'main',
      title: 't',
      body: 'b',
      cfg,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(result).toEqual({
      url: 'https://bitbucket.org/acme/api/pull-requests/5',
      isNew: false,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('creates a new PR when none is open, using basic auth', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      if (calls.length === 1) {
        return jsonResponse({ values: [] })
      }
      return jsonResponse({
        links: { html: { href: 'https://bitbucket.org/acme/api/pull-requests/9' } },
      })
    })
    const result = await bitbucket.openMergeRequest({
      org: 'acme',
      name: 'api',
      branch: 'feature/x',
      base: 'main',
      title: 'My PR',
      body: 'Description',
      cfg,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(result).toEqual({ url: 'https://bitbucket.org/acme/api/pull-requests/9', isNew: true })
    expect(calls[1].init.method).toBe('POST')
    const headers = calls[1].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(basicAuthHeader('me', 'tok'))
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      title: 'My PR',
      description: 'Description',
      source: { branch: { name: 'feature/x' } },
      destination: { branch: { name: 'main' } },
    })
  })

  it('throws a descriptive error when PR creation fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('?q=')) return jsonResponse({ values: [] })
      return jsonResponse('nope', false, 400)
    })
    await expect(
      bitbucket.openMergeRequest({
        org: 'acme',
        name: 'api',
        branch: 'feature/x',
        base: 'main',
        title: 't',
        body: 'b',
        cfg,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Bitbucket PR creation failed \(400\)/)
  })
})

describe('bitbucket.fetchPrStatus', () => {
  const cfg: GitHostConfig = { username: 'me', token: 'tok' }

  it('throws when credentials are missing', async () => {
    await expect(
      bitbucket.fetchPrStatus({
        fetchFn: vi.fn() as unknown as typeof fetch,
        now: () => 0,
        sessionId: 's1',
        url: 'https://bitbucket.org/acme/api/pull-requests/1',
        org: 'acme',
        name: 'api',
        number: 1,
        cfg: {},
      }),
    ).rejects.toThrow(/Bitbucket requires a username and app password/)
  })

  it('throws when the PR fetch fails', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 404))
    await expect(
      bitbucket.fetchPrStatus({
        fetchFn: fetchFn as unknown as typeof fetch,
        now: () => 0,
        sessionId: 's1',
        url: 'https://bitbucket.org/acme/api/pull-requests/1',
        org: 'acme',
        name: 'api',
        number: 1,
        cfg,
      }),
    ).rejects.toThrow(/Bitbucket PR fetch failed \(404\)/)
  })

  it('fetches the happy path: open PR, running CI, approved review', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} })
      if (url.endsWith('/pullrequests/42')) {
        return jsonResponse({
          state: 'OPEN',
          participants: [{ approved: true, state: 'approved' }],
        })
      }
      if (url.includes('/pullrequests/42/statuses')) {
        return jsonResponse({ values: [{ state: 'INPROGRESS' }] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await bitbucket.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1234,
      sessionId: 's1',
      url: 'https://bitbucket.org/acme/api/pull-requests/42',
      org: 'acme',
      name: 'api',
      number: 42,
      cfg,
    })
    expect(dto).toEqual({
      sessionId: 's1',
      url: 'https://bitbucket.org/acme/api/pull-requests/42',
      host: 'bitbucket',
      state: 'open',
      ci: 'running',
      review: 'approved',
      approvals: 1,
      checkedAt: 1234,
    })
    expect(calls[0].headers.Authorization).toBe(basicAuthHeader('me', 'tok'))
  })

  it('maps a merged PR with no statuses and no participants', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pullrequests/7')) {
        return jsonResponse({ state: 'MERGED' })
      }
      if (url.includes('/statuses')) {
        return jsonResponse({ values: [] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await bitbucket.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1,
      sessionId: 's1',
      url: 'https://bitbucket.org/acme/api/pull-requests/7',
      org: 'acme',
      name: 'api',
      number: 7,
      cfg,
    })
    expect(dto.state).toBe('merged')
    expect(dto.ci).toBe('none')
    expect(dto.review).toBe('none')
    expect(dto.approvals).toBe(0)
  })

  it('degrades ci to unknown when the statuses fetch fails, without failing the whole DTO', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pullrequests/3')) {
        return jsonResponse({ state: 'OPEN', participants: [] })
      }
      if (url.includes('/statuses')) {
        throw new Error('network error')
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await bitbucket.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1,
      sessionId: 's1',
      url: 'https://bitbucket.org/acme/api/pull-requests/3',
      org: 'acme',
      name: 'api',
      number: 3,
      cfg,
    })
    expect(dto.state).toBe('open')
    expect(dto.ci).toBe('unknown')
  })

  it('degrades review to unknown/0 when the PR payload has a malformed participants shape', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pullrequests/3')) {
        // participants is not an array — mapBitbucketReviews' .filter/.some will throw.
        return jsonResponse({ state: 'OPEN', participants: 'not-an-array' })
      }
      if (url.includes('/statuses')) {
        return jsonResponse({ values: [] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await bitbucket.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1,
      sessionId: 's1',
      url: 'https://bitbucket.org/acme/api/pull-requests/3',
      org: 'acme',
      name: 'api',
      number: 3,
      cfg,
    })
    expect(dto.review).toBe('unknown')
    expect(dto.approvals).toBe(0)
  })

  it('maps declined and superseded states to closed', async () => {
    for (const raw of ['DECLINED', 'SUPERSEDED']) {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/statuses')) return jsonResponse({ values: [] })
        return jsonResponse({ state: raw, participants: [] })
      })
      const dto = await bitbucket.fetchPrStatus({
        fetchFn: fetchFn as unknown as typeof fetch,
        now: () => 1,
        sessionId: 's1',
        url: 'https://bitbucket.org/acme/api/pull-requests/1',
        org: 'acme',
        name: 'api',
        number: 1,
        cfg,
      })
      expect(dto.state).toBe('closed')
    }
  })
})
