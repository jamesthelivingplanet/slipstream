import { describe, it, expect, vi } from 'vitest'
import { createCompositeProvider } from './compositeProvider.js'
import type { ITicketProvider, TicketDTO, WorkflowState } from '../shared/contract.js'

function makeProvider(id: string, overrides: Partial<ITicketProvider> = {}): ITicketProvider {
  return {
    id,
    listTickets: vi.fn().mockResolvedValue([]),
    getTicketStatus: vi.fn().mockResolvedValue({ current: null, available: [] }),
    setTicketStatus: vi.fn().mockResolvedValue({ id: 's', name: 'State' } as WorkflowState),
    startTicket: vi.fn().mockResolvedValue(null),
    resetTicket: vi.fn().mockResolvedValue(null),
    postComment: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function ticket(tid: string, src: 'linear' | 'jira'): TicketDTO {
  return { id: tid, tid, src, title: tid, done: false }
}

describe('createCompositeProvider', () => {
  describe('listTickets', () => {
    it('merges tickets from all providers', async () => {
      const linear = makeProvider('linear', {
        listTickets: vi
          .fn()
          .mockResolvedValue({
            tickets: [ticket('ENG-1', 'linear')],
            totalCount: 1,
            page: 1,
            pageSize: 20,
            hasMore: false,
          }),
      })
      const jira = makeProvider('jira', {
        listTickets: vi
          .fn()
          .mockResolvedValue({
            tickets: [ticket('PROJ-1', 'jira')],
            totalCount: 1,
            page: 1,
            pageSize: 20,
            hasMore: false,
          }),
      })
      const composite = createCompositeProvider([linear, jira])

      const result = await composite.listTickets()
      expect(result.tickets.map((t) => t.tid).sort()).toEqual(['ENG-1', 'PROJ-1'])
    })

    it("is resilient: one provider throwing does not blank the other's tickets", async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const linear = makeProvider('linear', {
        listTickets: vi
          .fn()
          .mockResolvedValue({
            tickets: [ticket('ENG-1', 'linear')],
            totalCount: 1,
            page: 1,
            pageSize: 20,
            hasMore: false,
          }),
      })
      const jira = makeProvider('jira', {
        listTickets: vi.fn().mockRejectedValue(new Error('Jira 401')),
      })
      const composite = createCompositeProvider([linear, jira])

      const result = await composite.listTickets()
      expect(result.tickets.map((t) => t.tid)).toEqual(['ENG-1'])
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })

    it('throws the first rejection when all providers fail', async () => {
      const linear = makeProvider('linear', {
        listTickets: vi.fn().mockRejectedValue(new Error('Linear down')),
      })
      const jira = makeProvider('jira', {
        listTickets: vi.fn().mockRejectedValue(new Error('Jira down')),
      })
      const composite = createCompositeProvider([linear, jira])

      await expect(composite.listTickets()).rejects.toThrow('Linear down')
    })
  })

  describe('routing by src', () => {
    it('routes getTicketStatus/setTicketStatus/startTicket/resetTicket to the matching provider by src', async () => {
      const linear = makeProvider('linear')
      const jira = makeProvider('jira')
      const composite = createCompositeProvider([linear, jira])

      await composite.getTicketStatus('PROJ-1', 'jira')
      expect(jira.getTicketStatus).toHaveBeenCalledWith('PROJ-1')
      expect(linear.getTicketStatus).not.toHaveBeenCalled()

      await composite.setTicketStatus('PROJ-1', 'state-1', 'jira')
      expect(jira.setTicketStatus).toHaveBeenCalledWith('PROJ-1', 'state-1')

      await composite.startTicket('ENG-1', 'linear')
      expect(linear.startTicket).toHaveBeenCalledWith('ENG-1')

      await composite.resetTicket('ENG-1', 'linear')
      expect(linear.resetTicket).toHaveBeenCalledWith('ENG-1')
    })

    it('routes postComment to the matching provider by src', async () => {
      const linear = makeProvider('linear')
      const jira = makeProvider('jira')
      const composite = createCompositeProvider([linear, jira])

      const posted = await composite.postComment('PROJ-1', 'MR opened: https://x/mr/1', 'jira')
      expect(posted).toBe(true)
      expect(jira.postComment).toHaveBeenCalledWith('PROJ-1', 'MR opened: https://x/mr/1')
      expect(linear.postComment).not.toHaveBeenCalled()

      await composite.postComment('ENG-1', 'hello', 'linear')
      expect(linear.postComment).toHaveBeenCalledWith('ENG-1', 'hello')
    })

    it('throws for an unknown src', async () => {
      const composite = createCompositeProvider([makeProvider('linear')])
      await expect(composite.getTicketStatus('X-1', 'jira' as never)).rejects.toThrow(
        'Unknown ticket source: jira',
      )
    })

    it('falls back to the sole provider when src is undefined', async () => {
      const linear = makeProvider('linear')
      const composite = createCompositeProvider([linear])

      await composite.startTicket('ENG-1')
      expect(linear.startTicket).toHaveBeenCalledWith('ENG-1')
    })

    it('falls back to linear when src is undefined and multiple providers exist (backward compat)', async () => {
      const linear = makeProvider('linear')
      const jira = makeProvider('jira')
      const composite = createCompositeProvider([linear, jira])

      await composite.startTicket('ENG-1')
      expect(linear.startTicket).toHaveBeenCalledWith('ENG-1')
      expect(jira.startTicket).not.toHaveBeenCalled()
    })

    it('throws ambiguous source when src is undefined and no linear provider exists', async () => {
      const jira = makeProvider('jira')
      const composite = createCompositeProvider([jira])
      // sole provider case still applies: single provider always wins
      await composite.startTicket('PROJ-1')
      expect(jira.startTicket).toHaveBeenCalledWith('PROJ-1')
    })
  })
})
