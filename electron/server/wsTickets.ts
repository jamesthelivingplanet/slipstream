import { randomBytes } from 'node:crypto'
import type { Identity } from '../shared/contract.js'

// See docs/SECURITY.md §3 — a ticket only needs to survive the gap between
// the POST /rpc-ticket response and the client's very next `new WebSocket(...)`
// call, not a session lifetime.
export const TICKET_TTL_MS = 10_000
const SWEEP_INTERVAL_MS = 5_000

interface TicketEntry {
  identity: Identity
  expiresAt: number
  used: boolean
}

export interface TicketStore {
  /** Mint a single-use ticket bound to `identity`, valid for `ttlMs`. */
  issue(identity: Identity): { ticket: string; expiresInMs: number }
  /**
   * Redeem a ticket: valid + unused + unexpired → marks it used and returns
   * the identity it was issued for. Anything else (unknown, expired, already
   * used) returns undefined — indistinguishable to the caller, matching the
   * existing bad-token rejection (no signal to a network observer).
   */
  redeem(ticket: string): Identity | undefined
  /** Stop the expiry sweeper (call on server shutdown). */
  dispose(): void
}

export function createTicketStore(ttlMs: number = TICKET_TTL_MS): TicketStore {
  const tickets = new Map<string, TicketEntry>()

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [ticket, entry] of tickets) {
      if (entry.used || entry.expiresAt <= now) tickets.delete(ticket)
    }
  }, SWEEP_INTERVAL_MS)
  sweeper.unref?.()

  return {
    issue(identity) {
      const ticket = randomBytes(32).toString('base64url')
      tickets.set(ticket, { identity, expiresAt: Date.now() + ttlMs, used: false })
      return { ticket, expiresInMs: ttlMs }
    },

    redeem(ticket) {
      const entry = tickets.get(ticket)
      if (!entry) return undefined
      // Mark used before anything else so a second redemption attempt (even
      // one racing in the same tick) sees `used: true` and is rejected —
      // identically to an unknown ticket.
      if (entry.used || entry.expiresAt <= Date.now()) return undefined
      entry.used = true
      return entry.identity
    },

    dispose() {
      clearInterval(sweeper)
    },
  }
}
