import type { ITicketProvider, WorkflowState, PaginatedTickets } from '../shared/contract.js'

export function createEmptyProvider(): ITicketProvider {
  return {
    id: 'none',
    async listTickets(): Promise<PaginatedTickets> {
      return { tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false }
    },
    async getTicketStatus(
      _tid: string,
    ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      return { current: null, available: [] }
    },
    async setTicketStatus(_tid: string, _stateId: string): Promise<WorkflowState> {
      throw new Error('No ticket provider configured')
    },
    async startTicket(_tid: string): Promise<WorkflowState | null> {
      return null
    },
    async resetTicket(_tid: string): Promise<WorkflowState | null> {
      return null
    },
    async postComment(_tid: string, _body: string): Promise<boolean> {
      return false
    },
  }
}
