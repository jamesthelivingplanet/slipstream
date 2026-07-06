import type { ISessionManager, ISessionStore, ITicketProvider } from '../shared/contract.js'
import type { RunLogger } from './runLogger.js'

export interface TicketWriteback {
  /** Remove the daemon-level session event listener. */
  dispose(): void
}

/**
 * FLO-98: daemon-level ticket write-back — post the PR/MR link as a comment on
 * the linked ticket when a session emits a `pr` event.
 *
 * Like sessionPersistence (FLO-69 rationale), this is wired ONCE for the
 * process lifetime in `createServices`, not per connected client: an agent
 * that opens a merge request with zero clients attached must still write the
 * link back to the ticket.
 *
 * ORDERING: this must be wired BEFORE `createSessionPersistence`. Both listen
 * to the `pr` event, and this service dedupes restarts by comparing the
 * incoming URL to `persisted.prUrl` — i.e. the value from *before* persistence
 * records the new URL. Node's EventEmitter invokes listeners in registration
 * order, so registering the write-back first guarantees it reads the
 * pre-persistence value.
 */
export function createTicketWriteback(deps: {
  sessions: Pick<ISessionManager, 'on' | 'off'>
  store: ISessionStore
  tickets: ITicketProvider
  logger?: RunLogger
}): TicketWriteback {
  const { sessions, store, tickets, logger } = deps

  // In-memory dedupe: a burst of pr.json watcher events for the same URL must
  // not double-post. Checked-and-added synchronously before the network call.
  const posted = new Set<string>()

  function onPr(sessionId: string, url: string): void {
    const persisted = store.get(sessionId)
    if (!persisted) return
    // Only sessions created from a real ticket get write-back — blank/TASK-draft
    // agents have no src, and calling the ticket API for them is just noise.
    if (!persisted.src) return
    // Restart dedupe: if the URL is already recorded, the comment was already
    // posted in a previous daemon lifetime (the pr.json watcher can re-fire
    // after a restart).
    if (persisted.prUrl === url) return
    const key = `${sessionId} ${url}`
    if (posted.has(key)) return
    posted.add(key)

    const body = `🔀 Slipstream opened a merge request for ${persisted.tid} (branch \`${persisted.branch}\`): ${url}`
    void (async () => {
      try {
        await tickets.postComment(persisted.tid, body, persisted.src)
      } catch (err) {
        // Best-effort: a ticket-API failure must never affect the session.
        logger?.server('warn', `ticket write-back failed for ${persisted.tid}`, err)
      }
    })()
  }

  sessions.on('pr', onPr)

  return {
    dispose(): void {
      sessions.off('pr', onPr)
    },
  }
}
