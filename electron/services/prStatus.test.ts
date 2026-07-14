import { describe, it, expect, vi } from 'vitest'
import {
  parsePrUrl,
  aggregateGithubChecks,
  mapGithubCombinedStatus,
  mapGithubReviews,
  mapGitlabPipelineStatus,
  mapGitlabMrState,
  createPrStatusService,
} from './prStatus.js'
import type { IConfigStore } from './configStore.js'

describe('parsePrUrl', () => {
  it('parses a github PR url', () => {
    expect(parsePrUrl('https://github.com/acme/api/pull/42')).toEqual({
      host: 'github',
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('tolerates a trailing slash on github urls', () => {
    expect(parsePrUrl('https://github.com/acme/api/pull/42/')).toEqual({
      host: 'github',
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('tolerates extra path segments after the number on github urls', () => {
    expect(parsePrUrl('https://github.com/acme/api/pull/42/files')).toEqual({
      host: 'github',
      org: 'acme',
      name: 'api',
      number: 42,
    })
  })

  it('parses a gitlab MR url with the modern /-/ separator', () => {
    expect(parsePrUrl('https://gitlab.com/acme/api/-/merge_requests/7')).toEqual({
      host: 'gitlab',
      org: 'acme',
      name: 'api',
      number: 7,
    })
  })

  it('parses a gitlab MR url with nested groups', () => {
    expect(parsePrUrl('https://gitlab.com/acme/platform/api/-/merge_requests/7')).toEqual({
      host: 'gitlab',
      org: 'acme/platform',
      name: 'api',
      number: 7,
    })
  })

  it('parses the legacy gitlab MR url form without /-/', () => {
    expect(parsePrUrl('https://gitlab.com/acme/api/merge_requests/7')).toEqual({
      host: 'gitlab',
      org: 'acme',
      name: 'api',
      number: 7,
    })
  })

  it('tolerates a trailing slash on gitlab urls', () => {
    expect(parsePrUrl('https://gitlab.com/acme/api/-/merge_requests/7/')).toEqual({
      host: 'gitlab',
      org: 'acme',
      name: 'api',
      number: 7,
    })
  })

  it('returns null for an unknown host', () => {
    // bitbucket.org matches since TASK-7LGAO; use a domain no provider claims
    // (gitea needs a configured baseUrl, which config-less parsePrUrl never has).
    expect(parsePrUrl('https://git.example.com/acme/api/pulls/1')).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(parsePrUrl('not-a-url')).toBeNull()
  })
})

describe('aggregateGithubChecks', () => {
  it('returns none for an empty run list', () => {
    expect(aggregateGithubChecks([])).toBe('none')
  })

  it('returns running when any run is not completed', () => {
    expect(
      aggregateGithubChecks([
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
      ]),
    ).toBe('running')
  })

  it('returns failed when any completed run has a failing conclusion', () => {
    expect(
      aggregateGithubChecks([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ]),
    ).toBe('failed')
  })

  it('returns passed when all runs succeeded/neutral/skipped', () => {
    expect(
      aggregateGithubChecks([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'neutral' },
        { status: 'completed', conclusion: 'skipped' },
      ]),
    ).toBe('passed')
  })
})

describe('mapGithubCombinedStatus', () => {
  it('returns none when there are no statuses', () => {
    expect(mapGithubCombinedStatus('pending', 0)).toBe('none')
  })
  it('maps success', () => {
    expect(mapGithubCombinedStatus('success', 3)).toBe('passed')
  })
  it('maps failure/error', () => {
    expect(mapGithubCombinedStatus('failure', 1)).toBe('failed')
    expect(mapGithubCombinedStatus('error', 1)).toBe('failed')
  })
  it('maps pending', () => {
    expect(mapGithubCombinedStatus('pending', 1)).toBe('pending')
  })
})

describe('mapGithubReviews', () => {
  it('takes the latest non-COMMENTED review per reviewer', () => {
    const result = mapGithubReviews([
      { user: { login: 'alice' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'alice' }, state: 'COMMENTED' },
      { user: { login: 'alice' }, state: 'APPROVED' },
    ])
    expect(result).toEqual({ review: 'approved', approvals: 1 })
  })

  it('any CHANGES_REQUESTED wins over approvals', () => {
    const result = mapGithubReviews([
      { user: { login: 'alice' }, state: 'APPROVED' },
      { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
    ])
    expect(result.review).toBe('changes_requested')
  })

  it('returns none when there are no substantive reviews', () => {
    expect(mapGithubReviews([{ user: { login: 'alice' }, state: 'COMMENTED' }])).toEqual({
      review: 'none',
      approvals: 0,
    })
  })

  it('counts distinct approving reviewers', () => {
    expect(
      mapGithubReviews([
        { user: { login: 'alice' }, state: 'APPROVED' },
        { user: { login: 'bob' }, state: 'APPROVED' },
      ]),
    ).toEqual({ review: 'approved', approvals: 2 })
  })
})

describe('mapGitlabPipelineStatus', () => {
  it('maps null/undefined to none', () => {
    expect(mapGitlabPipelineStatus(null)).toBe('none')
    expect(mapGitlabPipelineStatus(undefined)).toBe('none')
  })
  it('maps success/failed/canceled/running', () => {
    expect(mapGitlabPipelineStatus('success')).toBe('passed')
    expect(mapGitlabPipelineStatus('failed')).toBe('failed')
    expect(mapGitlabPipelineStatus('canceled')).toBe('failed')
    expect(mapGitlabPipelineStatus('running')).toBe('running')
  })
  it('maps the pending-ish family to pending', () => {
    for (const s of [
      'created',
      'pending',
      'waiting_for_resource',
      'preparing',
      'scheduled',
      'manual',
    ]) {
      expect(mapGitlabPipelineStatus(s)).toBe('pending')
    }
  })
  it('maps skipped to none and anything else to unknown', () => {
    expect(mapGitlabPipelineStatus('skipped')).toBe('none')
    expect(mapGitlabPipelineStatus('something-new')).toBe('unknown')
  })
})

describe('mapGitlabMrState', () => {
  it('maps opened/locked to open', () => {
    expect(mapGitlabMrState('opened')).toBe('open')
    expect(mapGitlabMrState('locked')).toBe('open')
  })
  it('maps merged and closed', () => {
    expect(mapGitlabMrState('merged')).toBe('merged')
    expect(mapGitlabMrState('closed')).toBe('closed')
  })
  it('maps anything else to unknown', () => {
    expect(mapGitlabMrState('weird')).toBe('unknown')
  })
})

// ── service ─────────────────────────────────────────────────────────────

function makeConfig(values: Record<string, string> = {}): IConfigStore {
  return {
    get: vi.fn((key: string) => values[key]),
    set: vi.fn(),
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('createPrStatusService', () => {
  it('returns null when the session has no prUrl', async () => {
    const svc = createPrStatusService({ config: makeConfig() })
    expect(await svc.get({ id: 's1', prUrl: undefined })).toBeNull()
  })

  it('returns an unknown DTO with an error when no token is configured', async () => {
    const svc = createPrStatusService({ config: makeConfig() })
    const dto = await svc.get({ id: 's1', prUrl: 'https://github.com/acme/api/pull/1' })
    expect(dto).toMatchObject({
      sessionId: 's1',
      host: 'github',
      state: 'unknown',
      ci: 'unknown',
      review: 'unknown',
      approvals: 0,
    })
    expect(dto?.error).toMatch(/No github token configured/)
  })

  it('returns a stable-fallback unknown DTO for an unparseable url', async () => {
    const svc = createPrStatusService({ config: makeConfig({ 'github.token': 'tok' }) })
    const dto = await svc.get({ id: 's1', prUrl: 'not-a-url' })
    expect(dto).toMatchObject({ host: 'github', state: 'unknown' })
    expect(dto?.error).toMatch(/Cannot parse PR URL/)
  })

  it('guesses bitbucket for an unparseable bitbucket.org url in the error DTO', async () => {
    const svc = createPrStatusService({ config: makeConfig() })
    const dto = await svc.get({ id: 's1', prUrl: 'https://bitbucket.org/acme' })
    expect(dto).toMatchObject({ host: 'bitbucket', state: 'unknown' })
    expect(dto?.error).toMatch(/Cannot parse PR URL/)
  })

  it('guesses gitea for an unparseable url on the configured gitea baseUrl host', async () => {
    const svc = createPrStatusService({
      config: makeConfig({ 'gitea.baseUrl': 'https://git.example.com' }),
    })
    const dto = await svc.get({ id: 's1', prUrl: 'https://git.example.com/acme' })
    expect(dto).toMatchObject({ host: 'gitea', state: 'unknown' })
    expect(dto?.error).toMatch(/Cannot parse PR URL/)
  })

  it('fetches the github happy path: open PR, passing checks, approved', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} })
      if (url.endsWith('/repos/acme/api/pulls/42')) {
        return jsonResponse({ state: 'open', merged: false, head: { sha: 'abc123' } })
      }
      if (url.includes('/commits/abc123/check-runs')) {
        return jsonResponse({
          total_count: 2,
          check_runs: [
            { status: 'completed', conclusion: 'success' },
            { status: 'completed', conclusion: 'success' },
          ],
        })
      }
      if (url.includes('/pulls/42/reviews')) {
        return jsonResponse([{ user: { login: 'alice' }, state: 'APPROVED' }])
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const svc = createPrStatusService({
      config: makeConfig({ 'github.token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1000,
    })
    const dto = await svc.get({ id: 's1', prUrl: 'https://github.com/acme/api/pull/42' })
    expect(dto).toEqual({
      sessionId: 's1',
      url: 'https://github.com/acme/api/pull/42',
      host: 'github',
      state: 'open',
      ci: 'passed',
      review: 'approved',
      approvals: 1,
      checkedAt: 1000,
    })
    expect(calls[0].headers.Authorization).toBe('Bearer tok')
    expect(calls[0].url).not.toContain('tok')
  })

  it('falls back to combined status when check-runs is empty', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return jsonResponse({ state: 'open', merged: false, head: { sha: 'abc123' } })
      }
      if (url.includes('/check-runs')) {
        return jsonResponse({ total_count: 0, check_runs: [] })
      }
      if (url.includes('/commits/abc123/status')) {
        return jsonResponse({ state: 'success', total_count: 1 })
      }
      if (url.includes('/reviews')) {
        return jsonResponse([])
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const svc = createPrStatusService({
      config: makeConfig({ 'github.token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const dto = await svc.get({ id: 's1', prUrl: 'https://github.com/acme/api/pull/42' })
    expect(dto?.ci).toBe('passed')
    expect(dto?.review).toBe('none')
  })

  it('fetches the gitlab happy path: merged MR, failed pipeline, approved', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} })
      if (url.includes('/merge_requests/7/approvals')) {
        return jsonResponse({ approved: true, approved_by: [{ user: { username: 'bob' } }] })
      }
      if (url.includes('/merge_requests/7')) {
        return jsonResponse({ state: 'merged', head_pipeline: { status: 'failed' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const svc = createPrStatusService({
      config: makeConfig({ 'gitlab.token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 2000,
    })
    const dto = await svc.get({
      id: 's1',
      prUrl: 'https://gitlab.com/acme/api/-/merge_requests/7',
    })
    expect(dto).toEqual({
      sessionId: 's1',
      url: 'https://gitlab.com/acme/api/-/merge_requests/7',
      host: 'gitlab',
      state: 'merged',
      ci: 'failed',
      review: 'approved',
      approvals: 1,
      checkedAt: 2000,
    })
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('tok')
    expect(calls.some((c) => c.url.includes(encodeURIComponent('acme/api')))).toBe(true)
  })

  it('returns an unknown DTO with error when the provider API fails', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 500))
    const svc = createPrStatusService({
      config: makeConfig({ 'github.token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const dto = await svc.get({ id: 's1', prUrl: 'https://github.com/acme/api/pull/42' })
    expect(dto?.state).toBe('unknown')
    expect(dto?.error).toMatch(/GitHub PR fetch failed/)
  })

  it('caches within the TTL and refetches after it expires', async () => {
    let time = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) {
        return jsonResponse({ state: 'open', merged: false, head: { sha: 'abc123' } })
      }
      if (url.includes('/check-runs')) {
        return jsonResponse({ total_count: 0, check_runs: [] })
      }
      if (url.includes('/status')) {
        return jsonResponse({ state: 'pending', total_count: 1 })
      }
      if (url.includes('/reviews')) {
        return jsonResponse([])
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const svc = createPrStatusService({
      config: makeConfig({ 'github.token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
      ttlMs: 1000,
      now: () => time,
    })
    const url = 'https://github.com/acme/api/pull/42'
    await svc.get({ id: 's1', prUrl: url })
    const callsAfterFirst = fetchFn.mock.calls.length
    time += 500
    await svc.get({ id: 's1', prUrl: url })
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst) // still within TTL

    time += 600 // now past the 1000ms TTL from the first fetch
    await svc.get({ id: 's1', prUrl: url })
    expect(fetchFn.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('caches an error DTO too, so a failing API is not hammered', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 500))
    let time = 0
    const svc = createPrStatusService({
      config: makeConfig({ 'github.token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
      ttlMs: 1000,
      now: () => time,
    })
    const url = 'https://github.com/acme/api/pull/42'
    await svc.get({ id: 's1', prUrl: url })
    const first = fetchFn.mock.calls.length
    time += 100
    await svc.get({ id: 's1', prUrl: url })
    expect(fetchFn.mock.calls.length).toBe(first)
  })
})
