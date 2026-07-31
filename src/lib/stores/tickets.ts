import { writable, get } from 'svelte/store'
import type { Source, Ticket } from '../types'
import { hasBackend, listTickets } from '../ipc'
import { pushToast } from '../toast'
import { isStartableTicket } from '../ticketFilter.js'
import { cleanError } from './errors.js'

export function dtoToTickets(
  dtos: {
    tid: string
    src: string
    title: string
    repoHint?: string
    description?: string
    status?: { id: string; name: string; type?: string }
    done: boolean
  }[],
): Ticket[] {
  return dtos.map((d) => ({
    tid: d.tid,
    src: d.src as Source,
    title: d.title,
    repo: d.repoHint ?? '',
    description: d.description,
    status: d.status,
    done: d.done,
  }))
}

export const tickets = writable<Ticket[]>([])

export const ticketsTotalCount = writable<number>(0)
export const ticketsPage = writable<number>(1)
export const ticketsPageSize = writable<number>(20)
export const ticketsHasMore = writable<boolean>(false)
export const ticketsLoading = writable<boolean>(false)
export const ticketsQuery = writable<string>('')

export async function refreshTickets(): Promise<void> {
  if (!hasBackend) return
  ticketsLoading.set(true)
  try {
    const page = get(ticketsPage)
    const pageSize = get(ticketsPageSize)
    const query = get(ticketsQuery)
    const result = await listTickets({ page, pageSize, query: query || undefined })
    tickets.set(dtoToTickets(result.tickets).filter(isStartableTicket))
    ticketsTotalCount.set(result.totalCount)
    ticketsHasMore.set(result.hasMore)
  } catch (e) {
    pushToast('error', cleanError(e))
  } finally {
    ticketsLoading.set(false)
  }
}

export async function loadMoreTickets(): Promise<void> {
  if (!hasBackend || get(ticketsLoading) || !get(ticketsHasMore)) return
  ticketsLoading.set(true)
  try {
    const nextPage = get(ticketsPage) + 1
    const pageSize = get(ticketsPageSize)
    const query = get(ticketsQuery)
    const result = await listTickets({ page: nextPage, pageSize, query: query || undefined })
    tickets.update(($t) => [...$t, ...dtoToTickets(result.tickets).filter(isStartableTicket)])
    ticketsTotalCount.set(result.totalCount)
    ticketsPage.set(nextPage)
    ticketsHasMore.set(result.hasMore)
  } catch (e) {
    pushToast('error', cleanError(e))
  } finally {
    ticketsLoading.set(false)
  }
}

export function setTicketsQuery(query: string): void {
  ticketsQuery.set(query)
  ticketsPage.set(1)
  refreshTickets()
}
