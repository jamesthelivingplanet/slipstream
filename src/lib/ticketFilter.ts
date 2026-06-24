import type { Ticket } from './types.js'

/** A ticket is selectable in the new-agent picker only when it's available to start —
 *  not done, not already In Progress (started), and not canceled. */
export function isStartableTicket(t: Pick<Ticket, 'done' | 'status'>): boolean {
  if (t.done) return false
  const type = t.status?.type
  return type !== 'started' && type !== 'canceled'
}
