import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGithubIssuesProvider, parseGithubTid } from './githubIssuesProvider.js'
import type { IConfigStore } from '../services/configStore.js'

function makeConfigStore(overrides: Record<string, string | undefined> = {}): IConfigStore {
  const values: Record<string, string | undefined> = { 'github.token': 'gh_tok_123', ...overrides }
  return {
    get: vi.fn((k: string) => values[k]),
    set: vi.fn(),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('createGithubIssuesProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('parseGithubTid', () => {
    it('parses owner/repo#number', () => {
      expect(parseGithubTid('acme/api#42')).toEqual({ owner: 'acme', repo: 'api', number: 42 })
    })

    it('throws a readable error on malformed input', () => {
      expect(() => parseGithubTid('no-hash')).toThrow('Invalid GitHub ticket id: no-hash')
      expect(() => parseGithubTid('acme/api#')).toThrow('Invalid GitHub ticket id: acme/api#')
      expect(() => parseGithubTid('#42')).toThrow('Invalid GitHub ticket id: #42')
      expect(() => parseGithubTid('acme#42')).toThrow('Invalid GitHub ticket id: acme#42')
      expect(() => parseGithubTid('acme/api#abc')).toThrow('Invalid GitHub ticket id: acme/api#abc')
    })
  })

  describe('listTickets', () => {
    it('returns empty and does not call fetch when unconfigured', async () => {
      const provider = createGithubIssuesProvider(makeConfigStore({ 'github.token': undefined }))
      const result = await provider.listTickets()
      expect(result).toEqual({ tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('returns empty and does not call fetch when no repo scope and onlyMine is off', async () => {
      const provider = createGithubIssuesProvider(makeConfigStore({ 'github.onlyMine': '0' }))
      const result = await provider.listTickets()
      expect(result).toEqual({ tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('calls the search API when onlyMine is on even without repo scope', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ total_count: 0, items: [] }))
      const provider = createGithubIssuesProvider(makeConfigStore())
      await provider.listTickets()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('builds the q string from scoped repos, onlyMine, and free-text query', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ total_count: 0, items: [] }))
      const provider = createGithubIssuesProvider(
        makeConfigStore({ 'github.issueRepos': 'acme/api, acme/web' }),
      )
      await provider.listTickets({ query: 'flaky test' })

      const url = vi.mocked(fetch).mock.calls[0][0] as string
      const q = new URL(url).searchParams.get('q') ?? ''
      expect(q).toContain('is:issue')
      expect(q).toContain('state:open')
      expect(q).toContain('repo:acme/api')
      expect(q).toContain('repo:acme/web')
      expect(q).toContain('assignee:@me')
      expect(q).toContain('flaky test')
    })

    it('sends the Bearer auth header and Accept header', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ total_count: 0, items: [] }))
      const provider = createGithubIssuesProvider(makeConfigStore())
      await provider.listTickets()

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.github.com/search/issues'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer gh_tok_123',
            Accept: 'application/vnd.github+json',
          }),
        }),
      )
    })

    it('maps search items to TicketDTOs, filtering out pull requests', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          total_count: 2,
          items: [
            {
              id: 111,
              number: 5,
              title: 'Fix the bug',
              body: 'Some details',
              state: 'open',
              repository_url: 'https://api.github.com/repos/acme/api',
            },
            {
              id: 222,
              number: 6,
              title: 'A pull request',
              state: 'open',
              repository_url: 'https://api.github.com/repos/acme/api',
              pull_request: { url: 'https://api.github.com/repos/acme/api/pulls/6' },
            },
          ],
        }),
      )

      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.listTickets()

      expect(result.tickets).toEqual([
        {
          id: '111',
          tid: 'acme/api#5',
          src: 'github',
          title: 'Fix the bug',
          description: 'Some details',
          done: false,
          repoHint: 'acme/api',
          status: { id: 'open', name: 'Open', type: 'unstarted' },
        },
      ])
      expect(result.totalCount).toBe(2)
    })

    it('maps a closed issue to done: true', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          total_count: 1,
          items: [
            {
              id: 1,
              number: 1,
              title: 'Closed one',
              state: 'closed',
              repository_url: 'https://api.github.com/repos/acme/api',
            },
          ],
        }),
      )
      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.listTickets()
      expect(result.tickets[0].done).toBe(true)
      expect(result.tickets[0].status).toEqual({ id: 'closed', name: 'Closed', type: 'completed' })
    })

    it('paginates via page/per_page and sets hasMore from the returned item count', async () => {
      const items = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        number: i,
        title: `Issue ${i}`,
        state: 'open',
        repository_url: 'https://api.github.com/repos/acme/api',
      }))
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ total_count: 40, items }))

      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.listTickets({ page: 2, pageSize: 20 })

      const url = vi.mocked(fetch).mock.calls[0][0] as string
      expect(url).toContain('per_page=20')
      expect(url).toContain('page=2')
      expect(result.hasMore).toBe(true)
      expect(result.totalCount).toBe(40)
    })

    it('throws a readable error on a non-ok response', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 401))
      const provider = createGithubIssuesProvider(makeConfigStore())
      await expect(provider.listTickets()).rejects.toThrow('GitHub API error: 401 Unauthorized')
    })
  })

  describe('listScopes', () => {
    it('maps /user/repos to ScopeOption[]', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse([{ id: 9, full_name: 'acme/api' }]))
      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.listScopes!()
      expect(result).toEqual([{ id: '9', key: 'acme/api', name: 'acme/api' }])
      expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/user/repos')
    })

    it('throws a readable error when the token is not set', async () => {
      const provider = createGithubIssuesProvider(makeConfigStore({ 'github.token': undefined }))
      await expect(provider.listScopes!()).rejects.toThrow('GitHub token not set')
    })

    it('throws a readable error on bad credentials (401)', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 401))
      const provider = createGithubIssuesProvider(makeConfigStore())
      await expect(provider.listScopes!()).rejects.toThrow('GitHub API error: 401 Unauthorized')
    })
  })

  describe('getTicketStatus / setTicketStatus', () => {
    it('getTicketStatus returns current + the other state as available', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ id: 1, number: 5, title: 't', state: 'open' }),
      )
      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.getTicketStatus('acme/api#5')

      expect(result.current).toEqual({ id: 'open', name: 'Open', type: 'unstarted' })
      expect(result.available).toEqual([{ id: 'closed', name: 'Closed', type: 'completed' }])
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://api.github.com/repos/acme/api/issues/5',
      )
    })

    it('setTicketStatus PATCHes state and returns the new WorkflowState', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ id: 1, number: 5, title: 't', state: 'closed' }),
      )
      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.setTicketStatus('acme/api#5', 'closed')

      expect(result).toEqual({ id: 'closed', name: 'Closed', type: 'completed' })
      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('https://api.github.com/repos/acme/api/issues/5')
      expect(call[1]!.method).toBe('PATCH')
      expect(JSON.parse(call[1]!.body as string)).toEqual({ state: 'closed' })
    })
  })

  describe('startTicket / resetTicket', () => {
    it('startTicket always returns null', async () => {
      const provider = createGithubIssuesProvider(makeConfigStore())
      expect(await provider.startTicket('acme/api#5')).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('resetTicket always returns null', async () => {
      const provider = createGithubIssuesProvider(makeConfigStore())
      expect(await provider.resetTicket('acme/api#5')).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('postComment', () => {
    it('returns false without fetching when unconfigured', async () => {
      const provider = createGithubIssuesProvider(makeConfigStore({ 'github.token': undefined }))
      const result = await provider.postComment('acme/api#5', 'hello')
      expect(result).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('POSTs a comment and returns true on success', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 1 }, 201))
      const provider = createGithubIssuesProvider(makeConfigStore())
      const result = await provider.postComment('acme/api#5', 'MR opened: https://x/mr/1')

      expect(result).toBe(true)
      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('https://api.github.com/repos/acme/api/issues/5/comments')
      expect(JSON.parse(call[1]!.body as string)).toEqual({ body: 'MR opened: https://x/mr/1' })
    })

    it('throws on an API failure', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 401))
      const provider = createGithubIssuesProvider(makeConfigStore())
      await expect(provider.postComment('acme/api#5', 'hello')).rejects.toThrow(
        'GitHub API error: 401 Unauthorized',
      )
    })
  })

  describe('getSettings / setSettings', () => {
    it('getSettings reflects configured + scope/onlyMine, ignoring credential fields', () => {
      const provider = createGithubIssuesProvider(
        makeConfigStore({ 'github.issueRepos': 'acme/api, acme/web', 'github.onlyMine': '0' }),
      )
      const settings = provider.getSettings()
      expect(settings).toEqual({
        configured: true,
        scopeKeys: ['acme/api', 'acme/web'],
        onlyMine: false,
        apiKey: '',
        baseUrl: '',
        email: '',
        apiToken: '',
      })
    })

    it('getSettings reports configured: false when no token is set', () => {
      const provider = createGithubIssuesProvider(makeConfigStore({ 'github.token': undefined }))
      expect(provider.getSettings().configured).toBe(false)
    })

    it('setSettings writes scope/onlyMine and ignores credential fields', () => {
      const store = makeConfigStore()
      const provider = createGithubIssuesProvider(store)
      provider.setSettings({
        configured: true,
        scopeKeys: ['acme/api'],
        onlyMine: false,
        apiKey: 'should-be-ignored',
        baseUrl: 'should-be-ignored',
        email: 'should-be-ignored',
        apiToken: 'should-be-ignored',
      })

      expect(store.set).toHaveBeenCalledWith('github.issueRepos', 'acme/api')
      expect(store.set).toHaveBeenCalledWith('github.onlyMine', '0')
      expect(store.set).not.toHaveBeenCalledWith('github.token', expect.anything())
    })
  })
})
