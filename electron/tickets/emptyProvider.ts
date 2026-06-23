import type { ITicketProvider, TicketDTO } from '../shared/contract.js'

export function createEmptyProvider(): ITicketProvider {
  return {
    id: 'none',
    async listTickets(): Promise<TicketDTO[]> {
      return []
    },
    async completeTicket(_tid: string): Promise<void> {},
  }
}
