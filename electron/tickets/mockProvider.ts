import type { ITicketProvider, TicketDTO } from '../shared/contract.js'

const TICKETS: TicketDTO[] = [
  {
    id: 'PROJ-149',
    tid: 'PROJ-149',
    src: 'linear',
    title: 'Dark mode flickers on cold load',
    repoHint: 'web',
  },
  {
    id: 'BILL-22',
    tid: 'BILL-22',
    src: 'linear',
    title: 'Stripe webhook retries dropping events',
    repoHint: 'billing',
  },
  {
    id: 'PROJ-160',
    tid: 'PROJ-160',
    src: 'jira',
    title: 'Migrate package manager to pnpm',
    repoHint: 'web',
  },
  {
    id: 'PROJ-158',
    tid: 'PROJ-158',
    src: 'jira',
    title: 'Push notification permission UX',
    repoHint: 'mobile',
  },
]

export function createMockProvider(): ITicketProvider {
  return {
    id: 'mock',
    listTickets(): Promise<TicketDTO[]> {
      return Promise.resolve(TICKETS)
    },
  }
}
