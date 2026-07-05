import type { ITicketProvider, TicketDTO, TicketSource, WorkflowState } from '../shared/contract.js'

/** Merges multiple ticket providers into a single ITicketProvider. Per-ticket
 *  ops route by the `src` param (falling back to the sole provider, or to
 *  'linear' for backward-compat sessions persisted before `src` existed). */
export function createCompositeProvider(providers: ITicketProvider[]): ITicketProvider {
  const byId = new Map<string, ITicketProvider>(providers.map((p) => [p.id, p]))

  function resolve(tid: string, src: TicketSource | undefined): ITicketProvider {
    if (src) {
      const p = byId.get(src)
      if (!p) throw new Error(`Unknown ticket source: ${src}`)
      return p
    }
    if (providers.length === 1) return providers[0]
    const linear = byId.get('linear')
    if (linear) return linear
    throw new Error(`Ambiguous ticket source for ${tid}`)
  }

  return {
    id: 'composite',

    async listTickets(): Promise<TicketDTO[]> {
      const results = await Promise.allSettled(providers.map((p) => p.listTickets()))

      const tickets: TicketDTO[] = []
      let anyRejected = false
      let firstRejection: unknown
      for (const result of results) {
        if (result.status === 'fulfilled') {
          tickets.push(...result.value)
        } else {
          anyRejected = true
          if (firstRejection === undefined) firstRejection = result.reason
          console.error('Ticket provider failed:', result.reason)
        }
      }

      if (anyRejected && tickets.length === 0) {
        throw firstRejection
      }

      return tickets
    },

    async getTicketStatus(
      tid: string,
      src?: TicketSource,
    ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      return resolve(tid, src).getTicketStatus(tid)
    },

    async setTicketStatus(
      tid: string,
      stateId: string,
      src?: TicketSource,
    ): Promise<WorkflowState> {
      return resolve(tid, src).setTicketStatus(tid, stateId)
    },

    async startTicket(tid: string, src?: TicketSource): Promise<WorkflowState | null> {
      return resolve(tid, src).startTicket(tid)
    },

    async resetTicket(tid: string, src?: TicketSource): Promise<WorkflowState | null> {
      return resolve(tid, src).resetTicket(tid)
    },
  }
}
