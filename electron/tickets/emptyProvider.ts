import type { ITicketProvider, TicketDTO, TicketTeam, WorkflowState, CreateTicketInput } from '../shared/contract.js'

export function createEmptyProvider(): ITicketProvider {
  return {
    id: 'none',
    async listTickets(): Promise<TicketDTO[]> {
      return []
    },
    async listTeams(): Promise<TicketTeam[]> {
      return []
    },
    async createTicket(_input: CreateTicketInput): Promise<TicketDTO> {
      throw new Error('No ticket provider configured')
    },
    async getTicketStatus(_tid: string): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      return { current: null, available: [] }
    },
    async setTicketStatus(_tid: string, _stateId: string): Promise<WorkflowState> {
      throw new Error('No ticket provider configured')
    },
  }
}
