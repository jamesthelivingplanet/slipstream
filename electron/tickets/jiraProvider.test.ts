import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createJiraProvider } from './jiraProvider.js'
import type { IConfigStore } from '../services/configStore.js'

const CREDS = {
  'jira.baseUrl': 'https://acme.atlassian.net',
  'jira.email': 'me@acme.com',
  'jira.apiToken': 'tok_123',
}

function makeConfigStore(overrides: Record<string, string | undefined> = {}): IConfigStore {
  const values: Record<string, string | undefined> = { ...CREDS, ...overrides }
  return {
    get: vi.fn((k: string) => values[k]),
    set: vi.fn(),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 204 ? 'No Content' : 'OK',
    text: async () => (status === 204 ? '' : JSON.stringify(body)),
  } as unknown as Response
}

describe('createJiraProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('listTickets', () => {
    it('returns [] and does not call fetch when unconfigured', async () => {
      const provider = createJiraProvider(
        makeConfigStore({
          'jira.baseUrl': undefined,
          'jira.email': undefined,
          'jira.apiToken': undefined,
        }),
      )
      const result = await provider.listTickets()
      expect(result).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    })

    it('returns [] when only some credentials are set', async () => {
      const provider = createJiraProvider(makeConfigStore({ 'jira.apiToken': undefined }))
      const result = await provider.listTickets()
      expect(result).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    })

    it('sends Basic auth header built from email:apiToken', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ issues: [] }))

      const provider = createJiraProvider(makeConfigStore())
      await provider.listTickets()

      const expected = 'Basic ' + Buffer.from('me@acme.com:tok_123').toString('base64')
      expect(fetch).toHaveBeenCalledWith(
        'https://acme.atlassian.net/rest/api/3/search/jql',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: expected }),
        }),
      )
    })

    it('posts to /rest/api/3/search/jql with the expected fields', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ issues: [] }))

      const provider = createJiraProvider(makeConfigStore())
      await provider.listTickets()

      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('https://acme.atlassian.net/rest/api/3/search/jql')
      const body = JSON.parse(call[1]!.body as string)
      expect(body.fields).toEqual(['summary', 'description', 'status', 'project'])
      expect(body.maxResults).toBe(100)
      expect(body.jql).toContain('statusCategory != Done')
      expect(body.jql).toContain('assignee = currentUser() OR assignee is EMPTY')
      expect(body.jql).toContain('ORDER BY updated DESC')
    })

    it('scopes jql to project keys when jira.projectKeys is set', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ issues: [] }))

      const provider = createJiraProvider(makeConfigStore({ 'jira.projectKeys': 'PROJ, INF' }))
      await provider.listTickets()

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
      expect(body.jql).toMatch(/^project in \(PROJ,INF\) AND/)
    })

    it('drops the assignee clause when jira.onlyMine is 0', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ issues: [] }))

      const provider = createJiraProvider(makeConfigStore({ 'jira.onlyMine': '0' }))
      await provider.listTickets()

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
      expect(body.jql).not.toContain('assignee')
    })

    it('maps issue fields to TicketDTO, extracting ADF description text', async () => {
      const adf = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
        ],
      }
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          issues: [
            {
              id: '10001',
              key: 'PROJ-1',
              fields: {
                summary: 'Fix the thing',
                description: adf,
                status: {
                  id: 's1',
                  name: 'In Progress',
                  statusCategory: { key: 'indeterminate' },
                },
                project: { key: 'PROJ' },
              },
            },
          ],
        }),
      )

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.listTickets()

      expect(result).toEqual([
        {
          id: '10001',
          tid: 'PROJ-1',
          src: 'jira',
          title: 'Fix the thing',
          description: 'First line\nSecond line',
          done: false,
          repoHint: 'PROJ',
          status: { id: 's1', name: 'In Progress', type: 'started' },
        },
      ])
    })

    it('maps done status category to done: true', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          issues: [
            {
              id: '2',
              key: 'PROJ-2',
              fields: {
                summary: 'Done thing',
                description: null,
                status: { id: 's2', name: 'Done', statusCategory: { key: 'done' } },
                project: { key: 'PROJ' },
              },
            },
          ],
        }),
      )
      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.listTickets()
      expect(result[0].done).toBe(true)
      expect(result[0].status).toEqual({ id: 's2', name: 'Done', type: 'completed' })
      expect(result[0].description).toBeUndefined()
    })

    it('follows nextPageToken up to 3 pages', async () => {
      const issueFor = (n: number) => ({
        id: `${n}`,
        key: `PROJ-${n}`,
        fields: {
          summary: `Issue ${n}`,
          status: { id: 's', name: 'To Do', statusCategory: { key: 'new' } },
          project: { key: 'PROJ' },
        },
      })
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ issues: [issueFor(1)], nextPageToken: 'p2' }))
        .mockResolvedValueOnce(jsonResponse({ issues: [issueFor(2)], nextPageToken: 'p3' }))
        .mockResolvedValueOnce(jsonResponse({ issues: [issueFor(3)] }))

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.listTickets()

      expect(fetch).toHaveBeenCalledTimes(3)
      expect(result.map((t) => t.tid)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
      const secondBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)
      expect(secondBody.nextPageToken).toBe('p2')
    })

    it('caps pagination at 3 pages even if nextPageToken keeps coming', async () => {
      const page = () => jsonResponse({ issues: [], nextPageToken: 'more' })
      vi.mocked(fetch).mockResolvedValue(page())

      const provider = createJiraProvider(makeConfigStore())
      await provider.listTickets()

      expect(fetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('setTicketStatus / startTicket / resetTicket', () => {
    it('setTicketStatus posts a transition then returns the refreshed status', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(undefined, 204)) // transition POST
        .mockResolvedValueOnce(
          jsonResponse({
            fields: { status: { id: 's3', name: 'Done', statusCategory: { key: 'done' } } },
          }),
        )

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.setTicketStatus('PROJ-1', 'transition-5')

      expect(result).toEqual({ id: 's3', name: 'Done', type: 'completed' })
      const transitionCall = vi.mocked(fetch).mock.calls[0]
      expect(transitionCall[0]).toBe(
        'https://acme.atlassian.net/rest/api/3/issue/PROJ-1/transitions',
      )
      const body = JSON.parse(transitionCall[1]!.body as string)
      expect(body).toEqual({ transition: { id: 'transition-5' } })
    })

    it('startTicket returns null when already started (idempotent)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          fields: {
            status: { id: 's1', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          },
        }),
      )

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.startTicket('PROJ-1')

      expect(result).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('startTicket transitions to the first indeterminate-category transition', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({
            fields: { status: { id: 's0', name: 'To Do', statusCategory: { key: 'new' } } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            transitions: [
              {
                id: 't1',
                name: 'Start Progress',
                to: { statusCategory: { key: 'indeterminate' } },
              },
              { id: 't2', name: 'Done', to: { statusCategory: { key: 'done' } } },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(undefined, 204))
        .mockResolvedValueOnce(
          jsonResponse({
            fields: {
              status: { id: 's1', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            },
          }),
        )

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.startTicket('PROJ-1')

      expect(result).toEqual({ id: 's1', name: 'In Progress', type: 'started' })
      const transitionBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string)
      expect(transitionBody).toEqual({ transition: { id: 't1' } })
    })

    it('startTicket returns null when no indeterminate transition exists', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({
            fields: { status: { id: 's0', name: 'To Do', statusCategory: { key: 'new' } } },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ transitions: [] }))

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.startTicket('PROJ-1')
      expect(result).toBeNull()
    })

    it('startTicket throws when not configured', async () => {
      const provider = createJiraProvider(makeConfigStore({ 'jira.apiToken': undefined }))
      await expect(provider.startTicket('PROJ-1')).rejects.toThrow('Jira not configured')
    })

    it('resetTicket returns null unless currently indeterminate', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          fields: { status: { id: 's0', name: 'To Do', statusCategory: { key: 'new' } } },
        }),
      )
      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.resetTicket('PROJ-1')
      expect(result).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('resetTicket transitions to the first new-category transition', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({
            fields: {
              status: { id: 's1', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            transitions: [
              { id: 't3', name: 'Back to To Do', to: { statusCategory: { key: 'new' } } },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(undefined, 204))
        .mockResolvedValueOnce(
          jsonResponse({
            fields: { status: { id: 's0', name: 'To Do', statusCategory: { key: 'new' } } },
          }),
        )

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.resetTicket('PROJ-1')
      expect(result).toEqual({ id: 's0', name: 'To Do', type: 'unstarted' })
    })
  })

  describe('listScopes', () => {
    it('maps project search results to ScopeOption[]', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ values: [{ id: '1', key: 'PROJ', name: 'Project One' }] }),
      )
      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.listScopes!()
      expect(result).toEqual([{ id: '1', key: 'PROJ', name: 'Project One' }])
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://acme.atlassian.net/rest/api/3/project/search?maxResults=100',
      )
    })

    it('throws when not configured', async () => {
      const provider = createJiraProvider(makeConfigStore({ 'jira.baseUrl': undefined }))
      await expect(provider.listScopes!()).rejects.toThrow('Jira not configured')
    })
  })

  it('throws a readable error on non-ok HTTP response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response)

    const provider = createJiraProvider(makeConfigStore())
    await expect(provider.listTickets()).rejects.toThrow('Jira API error: 401 Unauthorized')
  })

  describe('postComment', () => {
    it('returns false without fetching when unconfigured', async () => {
      const provider = createJiraProvider(
        makeConfigStore({
          'jira.baseUrl': undefined,
          'jira.email': undefined,
          'jira.apiToken': undefined,
        }),
      )
      const result = await provider.postComment('PROJ-1', 'MR: https://x/mr/1')
      expect(result).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('POSTs an ADF comment with URLs carrying link marks', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: '1000' }, 201))

      const provider = createJiraProvider(makeConfigStore())
      const result = await provider.postComment(
        'PROJ-1',
        'MR opened: https://gitlab.com/acme/api/-/merge_requests/7 for review',
      )

      expect(result).toBe(true)
      const call = vi.mocked(fetch).mock.calls[0]
      expect(call[0]).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment')
      expect(call[1]!.method).toBe('POST')
      const body = JSON.parse(call[1]!.body as string)
      expect(body.body.type).toBe('doc')
      expect(body.body.version).toBe(1)
      expect(body.body.content).toEqual([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'MR opened: ' },
            {
              type: 'text',
              text: 'https://gitlab.com/acme/api/-/merge_requests/7',
              marks: [
                {
                  type: 'link',
                  attrs: { href: 'https://gitlab.com/acme/api/-/merge_requests/7' },
                },
              ],
            },
            { type: 'text', text: ' for review' },
          ],
        },
      ])
    })

    it('throws on an API failure (non-ok response)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      } as Response)

      const provider = createJiraProvider(makeConfigStore())
      await expect(provider.postComment('PROJ-1', 'hello')).rejects.toThrow(
        'Jira API error: 403 Forbidden',
      )
    })
  })
})
