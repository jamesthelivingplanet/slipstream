import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLinearProvider } from './linearProvider.js'
import type { IConfigStore } from '../services/configStore.js'

function makeConfigStore(
  key?: string,
  extra: Record<string, string | undefined> = {},
): IConfigStore {
  return {
    get: vi.fn((k: string) => (k === 'linear.apiKey' ? key : extra[k])),
    set: vi.fn(),
  }
}

const mockNode = {
  id: 'issue-uuid-1',
  identifier: 'ENG-123',
  title: 'Fix the bug',
  description: 'Some details',
  team: { key: 'ENG' },
  state: { id: 'state-1', name: 'In Progress', type: 'started' },
}

const mockResponse = {
  data: {
    issues: {
      nodes: [mockNode],
    },
  },
}

describe('createLinearProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns [] when no API key is set', async () => {
    const provider = createLinearProvider(makeConfigStore(undefined))
    const result = await provider.listTickets()
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps Linear nodes to TicketDTOs correctly', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_test'))
    const result = await provider.listTickets()

    expect(result).toEqual([
      {
        id: 'issue-uuid-1',
        tid: 'ENG-123',
        src: 'linear',
        title: 'Fix the bug',
        description: 'Some details',
        done: false,
        repoHint: 'ENG',
        status: { id: 'state-1', name: 'In Progress', type: 'started' },
      },
    ])
  })

  it('sends Authorization header without Bearer prefix', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [] } } }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_mykey'))
    await provider.listTickets()

    expect(fetch).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'lin_api_mykey',
        }),
      }),
    )
  })

  it('throws on non-ok HTTP response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_bad'))
    await expect(provider.listTickets()).rejects.toThrow('Linear API error: 401 Unauthorized')
  })

  it('throws on GraphQL errors', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'Not authenticated' }] }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_bad'))
    await expect(provider.listTickets()).rejects.toThrow('Linear GraphQL error: Not authenticated')
  })

  it('maps a completed node to done: true', async () => {
    const completedNode = {
      id: 'issue-uuid-completed',
      identifier: 'ENG-789',
      title: 'Completed task',
      team: { key: 'ENG' },
      state: { id: 'state-done', name: 'Done', type: 'completed' },
    }
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [completedNode] } } }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_test'))
    const result = await provider.listTickets()
    expect(result[0].done).toBe(true)
    expect(result[0].status).toEqual({ id: 'state-done', name: 'Done', type: 'completed' })
  })

  it('handles missing team gracefully (repoHint undefined)', async () => {
    const nodeNoTeam = { id: 'uuid-2', identifier: 'ENG-456', title: 'No team issue' }
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [nodeNoTeam] } } }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_test'))
    const result = await provider.listTickets()
    expect(result[0].repoHint).toBeUndefined()
    expect(result[0].status).toBeUndefined()
  })

  it('getTicketStatus resolves issue then returns current + available states', async () => {
    // First call: resolveIssue
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              {
                id: 'issue-uuid-1',
                identifier: 'ENG-123',
                team: { id: 'team-1', key: 'ENG' },
                state: { id: 'state-1', name: 'In Progress', type: 'started' },
              },
            ],
          },
        },
      }),
    } as Response)
    // Second call: workflowStates
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          workflowStates: {
            nodes: [
              { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
              { id: 'state-1', name: 'In Progress', type: 'started', position: 1 },
              { id: 'state-done', name: 'Done', type: 'completed', position: 2 },
            ],
          },
        },
      }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_test'))
    const result = await provider.getTicketStatus('ENG-123')

    expect(result.current).toEqual({ id: 'state-1', name: 'In Progress', type: 'started' })
    expect(result.available).toEqual([
      { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
      { id: 'state-1', name: 'In Progress', type: 'started' },
      { id: 'state-done', name: 'Done', type: 'completed' },
    ])
  })

  it('setTicketStatus resolves issue then updates with issueUpdate', async () => {
    // First call: resolveIssue
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              {
                id: 'issue-uuid-1',
                identifier: 'ENG-123',
                team: { id: 'team-1', key: 'ENG' },
                state: { id: 'state-1', name: 'In Progress', type: 'started' },
              },
            ],
          },
        },
      }),
    } as Response)
    // Second call: issueUpdate
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              state: { id: 'state-done', name: 'Done', type: 'completed' },
            },
          },
        },
      }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_test'))
    const result = await provider.setTicketStatus('ENG-123', 'state-done')

    expect(result).toEqual({ id: 'state-done', name: 'Done', type: 'completed' })
  })

  describe('startTicket', () => {
    it('transitions to started state when issue is not yet started', async () => {
      // fetch #1: resolveIssue
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-backlog', name: 'Backlog', type: 'unstarted' },
                },
              ],
            },
          },
        }),
      } as Response)
      // fetch #2: workflowStates
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
                { id: 'state-1', name: 'In Progress', type: 'started', position: 1 },
              ],
            },
          },
        }),
      } as Response)
      // fetch #3: issueUpdate
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issueUpdate: {
              success: true,
              issue: { state: { id: 'state-1', name: 'In Progress', type: 'started' } },
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.startTicket('ENG-123')

      expect(result).toEqual({ id: 'state-1', name: 'In Progress', type: 'started' })
    })

    it('returns null when issue is already in a started state', async () => {
      // fetch #1: resolveIssue — already started
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-1', name: 'In Progress', type: 'started' },
                },
              ],
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.startTicket('ENG-123')

      expect(result).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('returns null when no started state exists in the team workflow', async () => {
      // fetch #1: resolveIssue
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-backlog', name: 'Backlog', type: 'unstarted' },
                },
              ],
            },
          },
        }),
      } as Response)
      // fetch #2: workflowStates — no started states
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
                { id: 'state-done', name: 'Done', type: 'completed', position: 2 },
              ],
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.startTicket('ENG-123')

      expect(result).toBeNull()
    })
  })

  describe('resetTicket', () => {
    it('transitions to unstarted state when issue is currently started', async () => {
      // fetch #1: resolveIssue — currently started
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-1', name: 'In Progress', type: 'started' },
                },
              ],
            },
          },
        }),
      } as Response)
      // fetch #2: workflowStates
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
                { id: 'state-todo', name: 'To Do', type: 'unstarted', position: 1 },
                { id: 'state-1', name: 'In Progress', type: 'started', position: 2 },
              ],
            },
          },
        }),
      } as Response)
      // fetch #3: issueUpdate
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issueUpdate: {
              success: true,
              issue: { state: { id: 'state-todo', name: 'To Do', type: 'unstarted' } },
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.resetTicket('ENG-123')

      expect(result).toEqual({ id: 'state-todo', name: 'To Do', type: 'unstarted' })
    })

    it('prefers unstarted over backlog when both exist', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-1', name: 'In Progress', type: 'started' },
                },
              ],
            },
          },
        }),
      } as Response)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
                { id: 'state-todo', name: 'To Do', type: 'unstarted', position: 1 },
              ],
            },
          },
        }),
      } as Response)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issueUpdate: {
              success: true,
              issue: { state: { id: 'state-todo', name: 'To Do', type: 'unstarted' } },
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.resetTicket('ENG-123')

      // Confirm the mutation was called with the unstarted state id, not backlog.
      expect(result).toEqual({ id: 'state-todo', name: 'To Do', type: 'unstarted' })
      const mutationCall = vi.mocked(fetch).mock.calls[2]
      const body = JSON.parse(mutationCall[1]!.body as string)
      expect(body.variables.stateId).toBe('state-todo')
    })

    it('returns null when issue is already in an unstarted state', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-todo', name: 'To Do', type: 'unstarted' },
                },
              ],
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.resetTicket('ENG-123')

      expect(result).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('returns null when issue is completed (does not reopen done tickets)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-done', name: 'Done', type: 'completed' },
                },
              ],
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.resetTicket('ENG-123')

      expect(result).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('returns null when no unstarted/backlog state exists in the team workflow', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-123',
                  team: { id: 'team-1', key: 'ENG' },
                  state: { id: 'state-1', name: 'In Progress', type: 'started' },
                },
              ],
            },
          },
        }),
      } as Response)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-1', name: 'In Progress', type: 'started', position: 0 },
                { id: 'state-done', name: 'Done', type: 'completed', position: 2 },
              ],
            },
          },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.resetTicket('ENG-123')

      expect(result).toBeNull()
    })
  })

  describe('listTickets scoping', () => {
    it('injects team filter into the request variables when linear.teamKeys is set', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      } as Response)

      const provider = createLinearProvider(
        makeConfigStore('lin_api_test', { 'linear.teamKeys': 'ENG, INF ,' }),
      )
      await provider.listTickets()

      const call = vi.mocked(fetch).mock.calls[0]
      const body = JSON.parse(call[1]!.body as string)
      expect(body.variables.filter.and).toContainEqual({ team: { key: { in: ['ENG', 'INF'] } } })
    })

    it('omits team filter when linear.teamKeys is unset', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      await provider.listTickets()

      const call = vi.mocked(fetch).mock.calls[0]
      const body = JSON.parse(call[1]!.body as string)
      expect(body.variables.filter.and.some((c: unknown) => (c as { team?: unknown }).team)).toBe(
        false,
      )
    })

    it('drops the assignee clause when linear.onlyMine is 0', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      } as Response)

      const provider = createLinearProvider(
        makeConfigStore('lin_api_test', { 'linear.onlyMine': '0' }),
      )
      await provider.listTickets()

      const call = vi.mocked(fetch).mock.calls[0]
      const body = JSON.parse(call[1]!.body as string)
      expect(body.variables.filter.and.some((c: unknown) => (c as { or?: unknown }).or)).toBe(false)
    })

    it('includes the assignee clause by default (onlyMine unset)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      await provider.listTickets()

      const call = vi.mocked(fetch).mock.calls[0]
      const body = JSON.parse(call[1]!.body as string)
      expect(body.variables.filter.and.some((c: unknown) => (c as { or?: unknown }).or)).toBe(true)
    })
  })

  describe('listScopes', () => {
    it('maps teams query to ScopeOption[]', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } },
        }),
      } as Response)

      const provider = createLinearProvider(makeConfigStore('lin_api_test'))
      const result = await provider.listScopes!()

      expect(result).toEqual([{ id: 't1', key: 'ENG', name: 'Engineering' }])
    })

    it('throws when no API key is set', async () => {
      const provider = createLinearProvider(makeConfigStore(undefined))
      await expect(provider.listScopes!()).rejects.toThrow('Linear API key not set')
    })
  })
})
