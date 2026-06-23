import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLinearProvider } from './linearProvider.js'
import type { IConfigStore } from '../services/configStore.js'

function makeConfigStore(key?: string): IConfigStore {
  return {
    get: vi.fn().mockReturnValue(key),
    set: vi.fn(),
  }
}

const mockNode = {
  id: 'issue-uuid-1',
  identifier: 'ENG-123',
  title: 'Fix the bug',
  description: 'Some details',
  team: { key: 'ENG' },
  state: { type: 'started' },
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
      state: { type: 'completed' },
    }
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [completedNode] } } }),
    } as Response)

    const provider = createLinearProvider(makeConfigStore('lin_api_test'))
    const result = await provider.listTickets()
    expect(result[0].done).toBe(true)
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
  })
})
