import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGitlabIssuesProvider, parseGitlabTid } from './gitlabIssuesProvider.js'
import type { IConfigStore } from '../services/configStore.js'

function makeConfigStore(overrides: Record<string, string | undefined> = {}): IConfigStore {
  const values: Record<string, string | undefined> = { 'gitlab.token': 'glpat_123', ...overrides }
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

describe('createGitlabIssuesProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('parseGitlabTid', () => {
    it('parses group/project#iid, including subgroup paths', () => {
      expect(parseGitlabTid('group/project#123')).toEqual({ path: 'group/project', iid: 123 })
      expect(parseGitlabTid('group/sub/project#7')).toEqual({
        path: 'group/sub/project',
        iid: 7,
      })
    })

    it('throws a readable error on malformed input', () => {
      expect(() => parseGitlabTid('no-hash')).toThrow('Invalid GitLab ticket id: no-hash')
      expect(() => parseGitlabTid('group/project#')).toThrow(
        'Invalid GitLab ticket id: group/project#',
      )
      expect(() => parseGitlabTid('#7')).toThrow('Invalid GitLab ticket id: #7')
      expect(() => parseGitlabTid('group/project#abc')).toThrow(
        'Invalid GitLab ticket id: group/project#abc',
      )
    })
  })

  describe('listTickets', () => {
    it('returns empty and does not call fetch when unconfigured', async () => {
      const provider = createGitlabIssuesProvider(makeConfigStore({ 'gitlab.token': undefined }))
      const result = await provider.listTickets()
      expect(result).toEqual({ tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('uses the global /issues endpoint when no project scope is configured', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse([]))
      const provider = createGitlabIssuesProvider(makeConfigStore())
      await provider.listTickets()

      expect(fetch).toHaveBeenCalledTimes(1)
      const url = vi.mocked(fetch).mock.calls[0][0] as string
      expect(url).toContain('/api/v4/issues?state=opened&scope=assigned_to_me')
    })

    it('fetches per configured project and merges results', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 1,
              iid: 1,
              title: 'A',
              state: 'opened',
              references: { full: 'group/api#1' },
            },
          ]),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 2,
              iid: 1,
              title: 'B',
              state: 'opened',
              references: { full: 'group/web#1' },
            },
          ]),
        )

      const provider = createGitlabIssuesProvider(
        makeConfigStore({ 'gitlab.issueProjects': 'group/api, group/web' }),
      )
      const result = await provider.listTickets()

      expect(fetch).toHaveBeenCalledTimes(2)
      const urls = vi.mocked(fetch).mock.calls.map((c) => c[0] as string)
      expect(urls[0]).toContain('/api/v4/projects/group%2Fapi/issues')
      expect(urls[1]).toContain('/api/v4/projects/group%2Fweb/issues')
      expect(result.tickets.map((t) => t.tid).sort()).toEqual(['group/api#1', 'group/web#1'])
    })

    it('scope=all when onlyMine is off, scope=assigned_to_me by default', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse([]))
      const provider = createGitlabIssuesProvider(makeConfigStore({ 'gitlab.onlyMine': '0' }))
      await provider.listTickets()
      expect(vi.mocked(fetch).mock.calls[0][0]).toContain('scope=all')
    })

    it('sends the PRIVATE-TOKEN header', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse([]))
      const provider = createGitlabIssuesProvider(makeConfigStore())
      await provider.listTickets()
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'glpat_123' }),
        }),
      )
    })

    it('maps issues to TicketDTOs using references.full as tid', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse([
          {
            id: 55,
            iid: 3,
            title: 'Fix it',
            description: 'Some details',
            state: 'opened',
            references: { full: 'group/api#3' },
          },
        ]),
      )
      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.listTickets()

      expect(result.tickets).toEqual([
        {
          id: '55',
          tid: 'group/api#3',
          src: 'gitlab',
          title: 'Fix it',
          description: 'Some details',
          done: false,
          repoHint: 'group/api',
          status: { id: 'opened', name: 'Open', type: 'unstarted' },
        },
      ])
    })

    it('maps a closed issue to done: true using the opened/closed vocabulary verbatim', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse([
          {
            id: 1,
            iid: 1,
            title: 'Done',
            state: 'closed',
            references: { full: 'group/api#1' },
          },
        ]),
      )
      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.listTickets()
      expect(result.tickets[0].done).toBe(true)
      expect(result.tickets[0].status).toEqual({ id: 'closed', name: 'Closed', type: 'completed' })
    })

    it('paginates client-side over the merged/fetched issue list', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        iid: i + 1,
        title: `Issue ${i}`,
        state: 'opened',
        references: { full: `group/api#${i + 1}` },
      }))
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(page1))
        .mockResolvedValue(jsonResponse([]))

      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.listTickets({ page: 2, pageSize: 20 })

      expect(result.tickets.length).toBe(20)
      expect(result.totalCount).toBe(100)
      expect(result.hasMore).toBe(true)
    })

    it('honors a non-default gitlab.baseUrl (self-hosted) in the fetch URL host', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse([]))
      const provider = createGitlabIssuesProvider(
        makeConfigStore({ 'gitlab.baseUrl': 'https://gitlab.example.com/' }),
      )
      await provider.listTickets()

      const url = vi.mocked(fetch).mock.calls[0][0] as string
      expect(url.startsWith('https://gitlab.example.com/api/v4/issues')).toBe(true)
    })

    it('throws a readable error on a non-ok response', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 401))
      const provider = createGitlabIssuesProvider(makeConfigStore())
      await expect(provider.listTickets()).rejects.toThrow('GitLab API error: 401 Unauthorized')
    })
  })

  describe('listScopes', () => {
    it('maps /projects to ScopeOption[]', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse([{ id: 3, path_with_namespace: 'group/api', name: 'API' }]),
      )
      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.listScopes!()
      expect(result).toEqual([{ id: '3', key: 'group/api', name: 'API' }])
      expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/v4/projects?membership=true')
    })

    it('throws a readable error when the token is not set', async () => {
      const provider = createGitlabIssuesProvider(makeConfigStore({ 'gitlab.token': undefined }))
      await expect(provider.listScopes!()).rejects.toThrow('GitLab token not set')
    })

    it('throws a readable error on bad credentials (401)', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 401))
      const provider = createGitlabIssuesProvider(makeConfigStore())
      await expect(provider.listScopes!()).rejects.toThrow('GitLab API error: 401 Unauthorized')
    })
  })

  describe('getTicketStatus / setTicketStatus', () => {
    it('getTicketStatus returns current + the other opened/closed state as available', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          id: 1,
          iid: 3,
          title: 't',
          state: 'opened',
          references: { full: 'group/api#3' },
        }),
      )
      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.getTicketStatus('group/api#3')

      expect(result.current).toEqual({ id: 'opened', name: 'Open', type: 'unstarted' })
      expect(result.available).toEqual([{ id: 'closed', name: 'Closed', type: 'completed' }])
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://gitlab.com/api/v4/projects/group%2Fapi/issues/3',
      )
    })

    it('setTicketStatus PUTs state_event: close for a closed target and returns the new state', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          id: 1,
          iid: 3,
          title: 't',
          state: 'closed',
          references: { full: 'group/api#3' },
        }),
      )
      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.setTicketStatus('group/api#3', 'closed')

      expect(result).toEqual({ id: 'closed', name: 'Closed', type: 'completed' })
      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[1]!.method).toBe('PUT')
      expect(JSON.parse(call[1]!.body as string)).toEqual({ state_event: 'close' })
    })

    it('setTicketStatus PUTs state_event: reopen for an opened target', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          id: 1,
          iid: 3,
          title: 't',
          state: 'opened',
          references: { full: 'group/api#3' },
        }),
      )
      const provider = createGitlabIssuesProvider(makeConfigStore())
      await provider.setTicketStatus('group/api#3', 'opened')

      const call = vi.mocked(fetch).mock.calls[0]
      expect(JSON.parse(call[1]!.body as string)).toEqual({ state_event: 'reopen' })
    })
  })

  describe('startTicket / resetTicket', () => {
    it('startTicket always returns null', async () => {
      const provider = createGitlabIssuesProvider(makeConfigStore())
      expect(await provider.startTicket('group/api#3')).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('resetTicket always returns null', async () => {
      const provider = createGitlabIssuesProvider(makeConfigStore())
      expect(await provider.resetTicket('group/api#3')).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('postComment', () => {
    it('returns false without fetching when unconfigured', async () => {
      const provider = createGitlabIssuesProvider(makeConfigStore({ 'gitlab.token': undefined }))
      const result = await provider.postComment('group/api#3', 'hello')
      expect(result).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('POSTs a note and returns true on success', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 1 }, 201))
      const provider = createGitlabIssuesProvider(makeConfigStore())
      const result = await provider.postComment('group/api#3', 'MR opened: https://x/mr/1')

      expect(result).toBe(true)
      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('https://gitlab.com/api/v4/projects/group%2Fapi/issues/3/notes')
      expect(JSON.parse(call[1]!.body as string)).toEqual({ body: 'MR opened: https://x/mr/1' })
    })

    it('throws on an API failure', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 401))
      const provider = createGitlabIssuesProvider(makeConfigStore())
      await expect(provider.postComment('group/api#3', 'hello')).rejects.toThrow(
        'GitLab API error: 401 Unauthorized',
      )
    })
  })

  describe('getSettings / setSettings', () => {
    it('getSettings reflects configured + scope/onlyMine, ignoring credential fields', () => {
      const provider = createGitlabIssuesProvider(
        makeConfigStore({ 'gitlab.issueProjects': 'group/api, group/web', 'gitlab.onlyMine': '0' }),
      )
      const settings = provider.getSettings()
      expect(settings).toEqual({
        configured: true,
        scopeKeys: ['group/api', 'group/web'],
        onlyMine: false,
        apiKey: '',
        baseUrl: '',
        email: '',
        apiToken: '',
      })
    })

    it('getSettings reports configured: false when no token is set', () => {
      const provider = createGitlabIssuesProvider(makeConfigStore({ 'gitlab.token': undefined }))
      expect(provider.getSettings().configured).toBe(false)
    })

    it('setSettings writes scope/onlyMine and ignores credential fields (incl. baseUrl)', () => {
      const store = makeConfigStore()
      const provider = createGitlabIssuesProvider(store)
      provider.setSettings({
        configured: true,
        scopeKeys: ['group/api'],
        onlyMine: false,
        apiKey: 'should-be-ignored',
        baseUrl: 'should-be-ignored',
        email: 'should-be-ignored',
        apiToken: 'should-be-ignored',
      })

      expect(store.set).toHaveBeenCalledWith('gitlab.issueProjects', 'group/api')
      expect(store.set).toHaveBeenCalledWith('gitlab.onlyMine', '0')
      expect(store.set).not.toHaveBeenCalledWith('gitlab.token', expect.anything())
      expect(store.set).not.toHaveBeenCalledWith('gitlab.baseUrl', expect.anything())
    })
  })
})
