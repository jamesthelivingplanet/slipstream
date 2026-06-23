import type { ITicketProvider, TicketDTO, WorkflowState } from '../shared/contract.js'

export function createEmptyProvider(): ITicketProvider {
  return {
    id: 'none',
    async listTickets(): Promise<TicketDTO[]> {
      return []
    },
    async getTicketStatus(_tid: string): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      return { current: null, available: [] }
    },
    async setTicketStatus(_tid: string, _stateId: string): Promise<WorkflowState> {
      throw new Error('No ticket provider configured')
    },
    async startTicket(_tid: string): Promise<WorkflowState | null> {
      return null
    },
  }
}
