import type {
  IAgentEventStore,
  IOutcomeStore,
  ISessionManager,
  ISessionStore,
  ITicketProvider,
} from '../shared/contract.js'
import { createTicketWriteback } from '../services/ticketWriteback.js'
import { createSessionPersistence } from '../services/sessionPersistence.js'
import type { RunLogger } from '../services/runLogger.js'

/**
 * FLO-98/FLO-69/FLO-136: registers the two daemon-level `pr` event listeners
 * in the one order that keeps the write-back's restart-dedupe correct.
 *
 * Both `createTicketWriteback` and `createSessionPersistence` listen to the
 * session manager's `pr` event. The write-back dedupes restarts by comparing
 * the incoming URL to `store.get(sessionId).prUrl` — the value from *before*
 * persistence records the new URL. Node's EventEmitter invokes listeners in
 * registration order, so `createTicketWriteback` MUST be registered first;
 * reversing these two calls makes persistence's listener run first, which
 * writes the URL to the store before the write-back reads it — the
 * write-back then sees its own dedupe condition as already true and never
 * posts the comment, on a green suite (see services.test.ts for the
 * composition test that pins this).
 *
 * Pulled out of `createServices` (which drags in native deps via `openDb`)
 * so the ordering itself is unit-testable against fakes.
 */
export function wirePrEventListeners(deps: {
  sessions: Pick<ISessionManager, 'on' | 'off'>
  store: ISessionStore
  tickets: ITicketProvider
  outcomes: IOutcomeStore
  agentEvents?: IAgentEventStore
  logger?: RunLogger
}): void {
  const { sessions, store, tickets, outcomes, agentEvents, logger } = deps

  createTicketWriteback({ sessions, store, tickets, logger })
  createSessionPersistence({ sessions, store, outcomes, agentEvents })
}
