import type {
  ITicketProvider,
  TicketDTO,
  TicketSource,
  WorkflowState,
  PaginatedTickets,
  TicketSourceSettings,
} from '../shared/contract.js'

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

    async listTickets(opts?: {
      page?: number
      pageSize?: number
      query?: string
    }): Promise<PaginatedTickets> {
      const results = await Promise.allSettled(providers.map((p) => p.listTickets(opts)))

      const allTickets: TicketDTO[] = []
      let anyRejected = false
      let firstRejection: unknown
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allTickets.push(...result.value.tickets)
        } else {
          anyRejected = true
          if (firstRejection === undefined) firstRejection = result.reason
          console.error('Ticket provider failed:', result.reason)
        }
      }

      if (anyRejected && allTickets.length === 0) {
        throw firstRejection
      }

      // Filter by query if provided
      let filtered = allTickets
      if (opts?.query) {
        const q = opts.query.toLowerCase()
        filtered = allTickets.filter(
          (t) => t.tid.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
        )
      }

      // Sort by updated (most recent first) - we need a proxy for this
      // For now, just sort by tid descending as a rough proxy
      filtered.sort((a, b) => b.tid.localeCompare(a.tid))

      // Apply pagination
      const page = opts?.page ?? 1
      const pageSize = opts?.pageSize ?? 20
      const start = (page - 1) * pageSize
      const end = start + pageSize
      const paginated = filtered.slice(start, end)

      return {
        tickets: paginated,
        totalCount: filtered.length,
        page,
        pageSize,
        hasMore: end < filtered.length,
      }
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

    async postComment(tid: string, body: string, src?: TicketSource): Promise<boolean> {
      return resolve(tid, src).postComment(tid, body)
    },

    // getSettings/setSettings take no tid/src to route by, unlike every other
    // method here — rpc.ts calls deps.ticketProviders?.[src] directly for
    // settings (see IPC.getTicketSettings/setTicketSettings), never through
    // the composite. These exist only so the composite still satisfies
    // ITicketProvider; the single-provider case is a reasonable fallback,
    // otherwise there's no way to pick a source without one.
    getSettings(): TicketSourceSettings {
      if (providers.length === 1) return providers[0].getSettings()
      throw new Error('getSettings is ambiguous on a composite ticket provider')
    },

    setSettings(_cfg: TicketSourceSettings): void {
      if (providers.length === 1) {
        providers[0].setSettings(_cfg)
        return
      }
      throw new Error('setSettings is ambiguous on a composite ticket provider')
    },
  }
}
