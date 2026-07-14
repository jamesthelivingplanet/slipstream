import { describe, it, expect, vi } from 'vitest'
import {
  normalizeBaseUrl,
  matchGiteaRemote,
  matchGiteaPrUrl,
  buildGiteaAuthPushUrl,
  buildGiteaFindPrDescriptor,
  buildGiteaCreatePrDescriptor,
  mapGiteaMergeState,
  mapGiteaCombinedStatus,
  mapGiteaReviews,
  gitea,
} from './gitea.js'
import type { GitHostConfig } from './types.js'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

// ── normalizeBaseUrl ───────────────────────────────────────────────────────

describe('normalizeBaseUrl', () => {
  it('trims whitespace', () => {
    expect(normalizeBaseUrl('  https://git.example.com  ')).toBe('https://git.example.com')
  })

  it('strips one or more trailing slashes', () => {
    expect(normalizeBaseUrl('https://git.example.com/')).toBe('https://git.example.com')
    expect(normalizeBaseUrl('https://git.example.com///')).toBe('https://git.example.com')
  })

  it('keeps a port', () => {
    expect(normalizeBaseUrl('https://git.example.com:3000')).toBe('https://git.example.com:3000')
  })

  it('accepts http', () => {
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('returns null for missing/empty input', () => {
    expect(normalizeBaseUrl(undefined)).toBeNull()
    expect(normalizeBaseUrl(null)).toBeNull()
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl('   ')).toBeNull()
  })

  it('returns null for unparseable input', () => {
    expect(normalizeBaseUrl('not a url')).toBeNull()
  })

  it('returns null for a non-http(s) protocol', () => {
    expect(normalizeBaseUrl('ftp://git.example.com')).toBeNull()
  })
})

// ── matchGiteaRemote ────────────────────────────────────────────────────────

describe('matchGiteaRemote', () => {
  const cfg: GitHostConfig = { baseUrl: 'https://git.example.com' }

  it('matches an https remote against the configured host', () => {
    expect(matchGiteaRemote('https://git.example.com/acme/api', cfg)).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an https remote with a .git suffix', () => {
    expect(matchGiteaRemote('https://git.example.com/acme/api.git', cfg)).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an ssh remote using hostname only (no port)', () => {
    expect(matchGiteaRemote('git@git.example.com:acme/api.git', cfg)).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an ssh remote even when baseUrl has a port', () => {
    const portedCfg: GitHostConfig = { baseUrl: 'https://git.example.com:3000' }
    expect(matchGiteaRemote('git@git.example.com:acme/api.git', portedCfg)).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('matches an https remote including the configured port', () => {
    const portedCfg: GitHostConfig = { baseUrl: 'https://git.example.com:3000' }
    expect(matchGiteaRemote('https://git.example.com:3000/acme/api.git', portedCfg)).toEqual({
      org: 'acme',
      name: 'api',
    })
    // Without the port it's a different host and must not match.
    expect(matchGiteaRemote('https://git.example.com/acme/api.git', portedCfg)).toBeNull()
  })

  it('matches when baseUrl has a trailing slash', () => {
    const trailingCfg: GitHostConfig = { baseUrl: 'https://git.example.com/' }
    expect(matchGiteaRemote('https://git.example.com/acme/api.git', trailingCfg)).toEqual({
      org: 'acme',
      name: 'api',
    })
  })

  it('returns null for a remote on a different domain', () => {
    expect(matchGiteaRemote('https://github.com/acme/api.git', cfg)).toBeNull()
    expect(matchGiteaRemote('git@github.com:acme/api.git', cfg)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(matchGiteaRemote('not-a-url', cfg)).toBeNull()
  })

  it('returns null when baseUrl is missing or invalid', () => {
    expect(matchGiteaRemote('https://git.example.com/acme/api.git', {})).toBeNull()
    expect(
      matchGiteaRemote('https://git.example.com/acme/api.git', { baseUrl: 'not a url' }),
    ).toBeNull()
  })
})

// ── matchGiteaPrUrl ─────────────────────────────────────────────────────────

describe('matchGiteaPrUrl', () => {
  const cfg: GitHostConfig = { baseUrl: 'https://git.example.com' }

  it('parses a plain PR url', () => {
    expect(matchGiteaPrUrl('https://git.example.com/acme/api/pulls/42', cfg)).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('tolerates a trailing slash', () => {
    expect(matchGiteaPrUrl('https://git.example.com/acme/api/pulls/42/', cfg)).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('tolerates extra path segments and query strings after the number', () => {
    expect(matchGiteaPrUrl('https://git.example.com/acme/api/pulls/42/files', cfg)).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
    expect(matchGiteaPrUrl('https://git.example.com/acme/api/pulls/42?tab=diff', cfg)).toEqual({
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('respects a port in baseUrl', () => {
    const portedCfg: GitHostConfig = { baseUrl: 'https://git.example.com:3000' }
    expect(matchGiteaPrUrl('https://git.example.com:3000/acme/api/pulls/7', portedCfg)).toEqual({
      org: 'acme',
      name: 'api',
      number: 7,
    })
  })

  it('returns null for a URL on a different domain', () => {
    expect(matchGiteaPrUrl('https://github.com/acme/api/pull/42', cfg)).toBeNull()
  })

  it('returns null when baseUrl is missing or invalid', () => {
    expect(matchGiteaPrUrl('https://git.example.com/acme/api/pulls/42', {})).toBeNull()
    expect(
      matchGiteaPrUrl('https://git.example.com/acme/api/pulls/42', { baseUrl: 'nope' }),
    ).toBeNull()
  })

  it('returns null for a non-PR path', () => {
    expect(matchGiteaPrUrl('https://git.example.com/acme/api', cfg)).toBeNull()
  })
})

// ── buildGiteaAuthPushUrl ────────────────────────────────────────────────────

describe('buildGiteaAuthPushUrl', () => {
  it('builds an oauth2-prefixed https push URL with an encoded token', () => {
    const cfg: GitHostConfig = { baseUrl: 'https://git.example.com', token: 'to ken/x' }
    expect(buildGiteaAuthPushUrl('https://git.example.com/acme/api.git', 'acme', 'api', cfg)).toBe(
      `https://oauth2:${encodeURIComponent('to ken/x')}@git.example.com/acme/api.git`,
    )
  })

  it('includes the port when baseUrl has one', () => {
    const cfg: GitHostConfig = { baseUrl: 'https://git.example.com:3000', token: 'tok' }
    expect(buildGiteaAuthPushUrl('irrelevant', 'acme', 'api', cfg)).toBe(
      'https://oauth2:tok@git.example.com:3000/acme/api.git',
    )
  })

  it('returns null when baseUrl is http (not https)', () => {
    const cfg: GitHostConfig = { baseUrl: 'http://git.example.com', token: 'tok' }
    expect(buildGiteaAuthPushUrl('irrelevant', 'acme', 'api', cfg)).toBeNull()
  })

  it('returns null when the token is missing', () => {
    const cfg: GitHostConfig = { baseUrl: 'https://git.example.com' }
    expect(buildGiteaAuthPushUrl('irrelevant', 'acme', 'api', cfg)).toBeNull()
  })

  it('returns null when baseUrl is missing or invalid', () => {
    expect(buildGiteaAuthPushUrl('irrelevant', 'acme', 'api', { token: 'tok' })).toBeNull()
    expect(
      buildGiteaAuthPushUrl('irrelevant', 'acme', 'api', { baseUrl: 'nope', token: 'tok' }),
    ).toBeNull()
  })
})

// ── descriptor builders ──────────────────────────────────────────────────────

describe('buildGiteaFindPrDescriptor', () => {
  it('builds the find-open-PRs GET request', () => {
    const desc = buildGiteaFindPrDescriptor({
      instanceUrl: 'https://git.example.com',
      org: 'acme',
      name: 'api',
      token: 'tok',
    })
    expect(desc.url).toBe('https://git.example.com/api/v1/repos/acme/api/pulls?state=open&limit=50')
    expect(desc.method).toBe('GET')
    expect(desc.headers.Authorization).toBe('token tok')
  })
})

describe('buildGiteaCreatePrDescriptor', () => {
  it('builds the create-PR POST request', () => {
    const desc = buildGiteaCreatePrDescriptor({
      instanceUrl: 'https://git.example.com',
      org: 'acme',
      name: 'api',
      branch: 'feature',
      base: 'main',
      title: 'My PR',
      body: 'desc',
      token: 'tok',
    })
    expect(desc.url).toBe('https://git.example.com/api/v1/repos/acme/api/pulls')
    expect(desc.method).toBe('POST')
    expect(desc.headers.Authorization).toBe('token tok')
    expect(desc.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(desc.body)).toEqual({
      title: 'My PR',
      body: 'desc',
      head: 'feature',
      base: 'main',
    })
  })
})

// ── mapGiteaMergeState ────────────────────────────────────────────────────────

describe('mapGiteaMergeState', () => {
  it('maps merged', () => {
    expect(mapGiteaMergeState({ merged: true, state: 'closed' })).toBe('merged')
  })
  it('maps open', () => {
    expect(mapGiteaMergeState({ merged: false, state: 'open' })).toBe('open')
  })
  it('maps closed (not merged)', () => {
    expect(mapGiteaMergeState({ merged: false, state: 'closed' })).toBe('closed')
  })
  it('maps anything else to unknown', () => {
    expect(mapGiteaMergeState({ state: 'weird' })).toBe('unknown')
    expect(mapGiteaMergeState({})).toBe('unknown')
  })
})

// ── mapGiteaCombinedStatus ────────────────────────────────────────────────────

describe('mapGiteaCombinedStatus', () => {
  it('returns none when there are no statuses', () => {
    expect(mapGiteaCombinedStatus('success', 0)).toBe('none')
  })
  it('maps success to passed', () => {
    expect(mapGiteaCombinedStatus('success', 2)).toBe('passed')
  })
  it('maps failure/error to failed', () => {
    expect(mapGiteaCombinedStatus('failure', 1)).toBe('failed')
    expect(mapGiteaCombinedStatus('error', 1)).toBe('failed')
  })
  it('maps pending', () => {
    expect(mapGiteaCombinedStatus('pending', 1)).toBe('pending')
  })
  it('maps warning to passed', () => {
    expect(mapGiteaCombinedStatus('warning', 1)).toBe('passed')
  })
  it('maps anything else to unknown', () => {
    expect(mapGiteaCombinedStatus('mystery', 1)).toBe('unknown')
  })
})

// ── mapGiteaReviews ──────────────────────────────────────────────────────────

describe('mapGiteaReviews', () => {
  it('takes the latest non-COMMENT review per reviewer', () => {
    const result = mapGiteaReviews([
      { user: { login: 'alice' }, state: 'REQUEST_CHANGES' },
      { user: { login: 'alice' }, state: 'COMMENT' },
      { user: { login: 'alice' }, state: 'APPROVED' },
    ])
    expect(result).toEqual({ review: 'approved', approvals: 1 })
  })

  it('any REQUEST_CHANGES wins over approvals', () => {
    const result = mapGiteaReviews([
      { user: { login: 'alice' }, state: 'APPROVED' },
      { user: { login: 'bob' }, state: 'REQUEST_CHANGES' },
    ])
    expect(result.review).toBe('changes_requested')
  })

  it('returns none when there are no substantive reviews', () => {
    expect(mapGiteaReviews([{ user: { login: 'alice' }, state: 'COMMENT' }])).toEqual({
      review: 'none',
      approvals: 0,
    })
    expect(mapGiteaReviews([])).toEqual({ review: 'none', approvals: 0 })
  })

  it('counts distinct approving reviewers', () => {
    expect(
      mapGiteaReviews([
        { user: { login: 'alice' }, state: 'APPROVED' },
        { user: { login: 'bob' }, state: 'APPROVED' },
      ]),
    ).toEqual({ review: 'approved', approvals: 2 })
  })

  it('ignores reviews with a null user', () => {
    expect(mapGiteaReviews([{ user: null, state: 'APPROVED' }])).toEqual({
      review: 'none',
      approvals: 0,
    })
  })
})

// ── gitea.openMergeRequest ────────────────────────────────────────────────────

describe('gitea.openMergeRequest', () => {
  const cfg: GitHostConfig = { baseUrl: 'https://git.example.com', token: 'tok' }

  it('returns the existing PR when one is open for the branch (filtering by head.ref)', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) {
        return jsonResponse([
          { html_url: 'https://git.example.com/acme/api/pulls/1', head: { ref: 'other-branch' } },
          { html_url: 'https://git.example.com/acme/api/pulls/2', head: { ref: 'feature' } },
        ])
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const result = await gitea.openMergeRequest({
      org: 'acme',
      name: 'api',
      branch: 'feature',
      base: 'main',
      title: 'My PR',
      body: 'desc',
      cfg,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(result).toEqual({ url: 'https://git.example.com/acme/api/pulls/2', isNew: false })
  })

  it('creates a new PR when none is open for the branch', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls?state=open')) {
        return jsonResponse([])
      }
      if (url.endsWith('/repos/acme/api/pulls') && init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toEqual({
          title: 'My PR',
          body: 'desc',
          head: 'feature',
          base: 'main',
        })
        return jsonResponse({ html_url: 'https://git.example.com/acme/api/pulls/3' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const result = await gitea.openMergeRequest({
      org: 'acme',
      name: 'api',
      branch: 'feature',
      base: 'main',
      title: 'My PR',
      body: 'desc',
      cfg,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(result).toEqual({ url: 'https://git.example.com/acme/api/pulls/3', isNew: true })
  })

  it('throws a descriptive error when creation fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) return jsonResponse([])
      return jsonResponse('validation failed', false, 422)
    })
    await expect(
      gitea.openMergeRequest({
        org: 'acme',
        name: 'api',
        branch: 'feature',
        base: 'main',
        title: 'My PR',
        body: 'desc',
        cfg,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Gitea PR creation failed \(422\)/)
  })

  it('throws a clear error when baseUrl or token is missing', async () => {
    const params = {
      org: 'acme',
      name: 'api',
      branch: 'feature',
      base: 'main',
      title: 'My PR',
      body: 'desc',
      fetchFn: vi.fn() as unknown as typeof fetch,
    }
    await expect(gitea.openMergeRequest({ ...params, cfg: {} })).rejects.toThrow(
      /base URL and access token/,
    )
    await expect(
      gitea.openMergeRequest({ ...params, cfg: { baseUrl: 'https://git.example.com' } }),
    ).rejects.toThrow(/base URL and access token/)
    await expect(gitea.openMergeRequest({ ...params, cfg: { token: 'tok' } })).rejects.toThrow(
      /base URL and access token/,
    )
  })
})

// ── gitea.fetchPrStatus ───────────────────────────────────────────────────────

describe('gitea.fetchPrStatus', () => {
  const cfg: GitHostConfig = { baseUrl: 'https://git.example.com', token: 'tok' }

  it('fetches the happy path: open PR, passing combined status, approved', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} })
      if (url.endsWith('/pulls/42')) {
        return jsonResponse({ state: 'open', merged: false, head: { sha: 'abc123' } })
      }
      if (url.includes('/commits/abc123/status')) {
        return jsonResponse({ state: 'success', statuses: [{ id: 1 }, { id: 2 }] })
      }
      if (url.includes('/pulls/42/reviews')) {
        return jsonResponse([{ user: { login: 'alice' }, state: 'APPROVED' }])
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await gitea.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1000,
      sessionId: 's1',
      url: 'https://git.example.com/acme/api/pulls/42',
      org: 'acme',
      name: 'api',
      number: 42,
      cfg,
    })
    expect(dto).toEqual({
      sessionId: 's1',
      url: 'https://git.example.com/acme/api/pulls/42',
      host: 'gitea',
      state: 'open',
      ci: 'passed',
      review: 'approved',
      approvals: 1,
      checkedAt: 1000,
    })
    expect(calls[0].headers.Authorization).toBe('token tok')
  })

  it('maps a merged PR', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return jsonResponse({ state: 'closed', merged: true, head: { sha: 'abc123' } })
      }
      if (url.includes('/status')) return jsonResponse({ state: 'success', statuses: [] })
      if (url.includes('/reviews')) return jsonResponse([])
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await gitea.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1000,
      sessionId: 's1',
      url: 'https://git.example.com/acme/api/pulls/42',
      org: 'acme',
      name: 'api',
      number: 42,
      cfg,
    })
    expect(dto.state).toBe('merged')
    expect(dto.ci).toBe('none')
  })

  it('falls back to unknown CI on a failed status fetch without failing the whole DTO', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return jsonResponse({ state: 'open', merged: false, head: { sha: 'abc123' } })
      }
      if (url.includes('/status')) return jsonResponse({}, false, 500)
      if (url.includes('/reviews')) return jsonResponse([])
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await gitea.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1000,
      sessionId: 's1',
      url: 'https://git.example.com/acme/api/pulls/42',
      org: 'acme',
      name: 'api',
      number: 42,
      cfg,
    })
    expect(dto.ci).toBe('unknown')
    expect(dto.state).toBe('open')
  })

  it('falls back to unknown review on a failed reviews fetch without failing the whole DTO', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return jsonResponse({ state: 'open', merged: false, head: { sha: 'abc123' } })
      }
      if (url.includes('/status')) return jsonResponse({ state: 'success', statuses: [{ id: 1 }] })
      if (url.includes('/reviews')) throw new Error('network error')
      throw new Error(`unexpected fetch: ${url}`)
    })
    const dto = await gitea.fetchPrStatus({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1000,
      sessionId: 's1',
      url: 'https://git.example.com/acme/api/pulls/42',
      org: 'acme',
      name: 'api',
      number: 42,
      cfg,
    })
    expect(dto.review).toBe('unknown')
    expect(dto.approvals).toBe(0)
    expect(dto.ci).toBe('passed')
  })

  it('throws when the PR fetch itself fails', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 404))
    await expect(
      gitea.fetchPrStatus({
        fetchFn: fetchFn as unknown as typeof fetch,
        now: () => 1000,
        sessionId: 's1',
        url: 'https://git.example.com/acme/api/pulls/42',
        org: 'acme',
        name: 'api',
        number: 42,
        cfg,
      }),
    ).rejects.toThrow(/Gitea PR fetch failed \(404\)/)
  })

  it('throws a clear error when baseUrl or token is missing', async () => {
    const params = {
      fetchFn: vi.fn() as unknown as typeof fetch,
      now: () => 1000,
      sessionId: 's1',
      url: 'https://git.example.com/acme/api/pulls/42',
      org: 'acme',
      name: 'api',
      number: 42,
    }
    await expect(gitea.fetchPrStatus({ ...params, cfg: {} })).rejects.toThrow(
      /base URL and access token/,
    )
  })
})

// ── provider metadata ────────────────────────────────────────────────────────

describe('gitea.meta', () => {
  it('keeps the registered id/needsUsername/needsBaseUrl', () => {
    expect(gitea.meta).toMatchObject({
      id: 'gitea',
      needsUsername: false,
      needsBaseUrl: true,
    })
  })
})
