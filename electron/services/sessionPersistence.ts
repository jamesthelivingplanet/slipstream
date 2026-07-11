import type {
  IAgentEventStore,
  IOutcomeStore,
  ISessionManager,
  ISessionStore,
  SessionAgentEventDTO,
  SessionOutcomeDTO,
  SessionStatus,
} from '../shared/contract.js'

export interface SessionPersistence {
  /** Remove the daemon-level session event listeners. */
  dispose(): void
}

/**
 * Daemon-level persistence of session status + PR-URL changes.
 *
 * FLO-69: this is wired ONCE for the process lifetime in `createServices` — it
 * is deliberately NOT tied to a connected WebSocket client. Persistence used to
 * live inside `createRpc`, which only exists while a client is attached, so an
 * agent that finished (or emitted a `pr.json` sentinel) with zero clients
 * connected never wrote its final state to SQLite. Because there is a single
 * listener per daemon, a status change is persisted exactly once even when
 * multiple clients are attached — the per-client RPC listeners only push live
 * updates to their transport.
 *
 * The terminal PTY-exit status (`done`/`errored`) is emitted as a `status`
 * event immediately before the `exit` event, so persisting on `status` already
 * captures the final state on exit.
 */
export function createSessionPersistence(deps: {
  sessions: Pick<ISessionManager, 'on' | 'off'>
  store: ISessionStore
  outcomes: IOutcomeStore
  /** Optional: checkpoint/artifact/approval events (FLO-104). */
  agentEvents?: IAgentEventStore
}): SessionPersistence {
  const { sessions, store, outcomes, agentEvents } = deps

  function onStatus(sessionId: string, status: SessionStatus): void {
    const persisted = store.get(sessionId)
    if (persisted && persisted.status !== status) {
      store.upsert({ ...persisted, status })
    }
  }

  function onPr(sessionId: string, url: string): void {
    const persisted = store.get(sessionId)
    if (persisted && persisted.prUrl !== url) {
      store.upsert({ ...persisted, prUrl: url })
    }
  }

  // Keyed by sessionId; last write wins (no staleness check needed — a
  // report_outcome call is a single terminal event per run, not a stream).
  function onOutcome(sessionId: string, outcome: SessionOutcomeDTO): void {
    outcomes.upsert(outcome)
  }

  // Insert is INSERT OR IGNORE on (sessionId, kind, ts): the watcher replays
  // the whole events.ndjson after a daemon restart, so re-delivery is expected
  // and must not duplicate rows.
  function onAgentEvent(_sessionId: string, event: SessionAgentEventDTO): void {
    agentEvents?.insert(event)
  }

  sessions.on('status', onStatus)
  sessions.on('pr', onPr)
  sessions.on('outcome', onOutcome)
  sessions.on('agentEvent', onAgentEvent)

  return {
    dispose(): void {
      sessions.off('status', onStatus)
      sessions.off('pr', onPr)
      sessions.off('outcome', onOutcome)
      sessions.off('agentEvent', onAgentEvent)
    },
  }
}
