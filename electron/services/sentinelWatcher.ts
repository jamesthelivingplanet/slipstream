/**
 * sentinelWatcher — fs.watch multiplexer over a session's sentinel directory
 * (pr.json / status.json / outcome.json / events.ndjson), extracted from the
 * 110-line anonymous closure that used to live inline in sessionManager's
 * launch() (FLO-119). Owns the per-file dedupe cursors and the pty-vs-poll
 * status merge (StatusDetector.applySignal vs the sentinel's state verbatim)
 * so both are directly unit-testable without a real PTY. File parsing itself
 * stays in statusSentinel.ts/outcomeSentinel.ts/agentEventsSentinel.ts —
 * this module only wires fs events to those parsers and dedupes/merges the
 * result.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { SessionStatus, StatusMeta } from '../shared/contract.js'
import type { StatusDetector } from './statusDetector.js'
import { parseStatusSentinel, STATUS_SENTINEL_FILE } from './statusSentinel.js'
import {
  parseOutcomeSentinel,
  OUTCOME_SENTINEL_FILE,
  type OutcomeSentinel,
} from './outcomeSentinel.js'
import { parseAgentEvents, AGENT_EVENTS_FILE, type AgentEventLine } from './agentEventsSentinel.js'

export interface SentinelWatcherCallbacks {
  /** pr.json: url, deduped internally across repeated writes of the same url. */
  onPr(url: string): void
  onOutcome(outcome: OutcomeSentinel): void
  onAgentEvent(event: AgentEventLine): void
  /** Fires on every status.json write newer than the last one seen. `status`
   *  is already merged (see `ptyDriven` below); `activityMessage` is the
   *  episode-scoped "what is the agent asking" text (set only alongside a
   *  transition into 'needs' with a message, cleared otherwise). */
  onStatus(
    status: SessionStatus,
    meta: StatusMeta | undefined,
    activityMessage: string | undefined,
  ): void
}

export interface SentinelWatcher {
  close(): void
}

/**
 * Watch `dir` for the four sentinel files and dispatch parsed, deduped
 * updates to `callbacks`. `ptyDriven` selects the status merge strategy:
 * pty-driven backends (StatusDetector scrapes PTY output) route the
 * sentinel's reported state through `detector.applySignal` so it merges with
 * the heuristic; poll-driven backends (no reliable PTY signal) take the
 * sentinel's state verbatim.
 *
 * `dir` may not exist yet — it's created (recursive) before the watch is
 * installed. `close()` is safe to call before that setup completes (it's
 * async): the pending setup notices and tears itself down instead of leaking
 * a watcher past teardown.
 */
export function createSentinelWatcher(
  dir: string,
  detector: StatusDetector,
  ptyDriven: boolean,
  callbacks: SentinelWatcherCallbacks,
): SentinelWatcher {
  const emittedPrUrl = new Set<string>()
  let lastStatusTs = 0
  let lastOutcomeTs = 0
  // Deliberately starts at 0: after a daemon restart the whole events.ndjson
  // history is re-emitted; the DB layer's INSERT OR IGNORE (unique on
  // sessionId/kind/ts) makes the replay idempotent.
  let lastAgentEventTs = 0
  let fsWatcher: fs.FSWatcher | undefined
  let closed = false

  void fs.promises
    .mkdir(dir, { recursive: true })
    .then(() => {
      if (closed) return
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (
            filename !== 'pr.json' &&
            filename !== STATUS_SENTINEL_FILE &&
            filename !== OUTCOME_SENTINEL_FILE &&
            filename !== AGENT_EVENTS_FILE
          )
            return

          if (filename === 'pr.json') {
            try {
              const content = fs.readFileSync(path.join(dir, 'pr.json'), 'utf8')
              const parsed = JSON.parse(content) as { url?: string }
              if (parsed.url && !emittedPrUrl.has(parsed.url)) {
                emittedPrUrl.add(parsed.url)
                callbacks.onPr(parsed.url)
              }
            } catch {
              // Ignore read/parse errors (file may be partially written)
            }
            return
          }

          if (filename === OUTCOME_SENTINEL_FILE) {
            try {
              const content = fs.readFileSync(path.join(dir, OUTCOME_SENTINEL_FILE), 'utf8')
              const parsed = parseOutcomeSentinel(content)
              if (parsed && parsed.ts > lastOutcomeTs) {
                lastOutcomeTs = parsed.ts
                callbacks.onOutcome(parsed)
              }
            } catch {
              // Ignore read/parse errors (file may be partially written)
            }
            return
          }

          if (filename === AGENT_EVENTS_FILE) {
            try {
              const content = fs.readFileSync(path.join(dir, AGENT_EVENTS_FILE), 'utf8')
              const events = parseAgentEvents(content).filter((e) => e.ts > lastAgentEventTs)
              for (const event of events) {
                lastAgentEventTs = event.ts
                callbacks.onAgentEvent(event)
              }
            } catch {
              // Ignore read/parse errors (file may be partially written)
            }
            return
          }

          // filename === STATUS_SENTINEL_FILE
          try {
            const content = fs.readFileSync(path.join(dir, STATUS_SENTINEL_FILE), 'utf8')
            const parsed = parseStatusSentinel(content)
            if (parsed && parsed.ts > lastStatusTs) {
              lastStatusTs = parsed.ts
              // reason/message ride along as meta so status consumers
              // (detector, reaper, badges) stay reason-blind.
              const meta =
                parsed.reason !== undefined || parsed.message !== undefined
                  ? { reason: parsed.reason, message: parsed.message }
                  : undefined
              let status: SessionStatus
              if (ptyDriven) {
                detector.applySignal(parsed.state)
                status = detector.status()
              } else {
                status = parsed.state
              }
              const activityMessage = status === 'needs' ? meta?.message : undefined
              callbacks.onStatus(status, meta, activityMessage)
            }
          } catch {
            // Ignore read/parse errors (file may be partially written)
          }
        })
        watcher.on('error', () => {
          /* ignore */
        })
        fsWatcher = watcher
      } catch {
        // Ignore watch errors
      }
    })
    .catch(() => {
      /* ignore mkdir errors */
    })

  return {
    close() {
      closed = true
      fsWatcher?.close()
      fsWatcher = undefined
    },
  }
}
