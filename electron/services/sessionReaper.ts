/**
 * SessionReaper — FLO-52 session GC / cost guard.
 *
 * Periodically evaluates every live PTY session against the configured
 * GcPolicy and reaps (kills + marks 'reaped') sessions that are abandoned,
 * idle too long, too old, or done with autoStopOnDone set. Pure, node-runnable
 * — only depends on the ISessionManager/ISessionStore/IConfigStore interfaces
 * (fakes in tests), never node-pty/better-sqlite3 directly.
 */

import type { GcPolicy, ISessionManager, ISessionStore, LiveSessionInfo } from '../shared/contract.js'
import { DEFAULT_GC_POLICY } from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import type { RunLogger } from './runLogger.js'

const GC_POLICY_KEY = 'gc.policy'
const REAP_INTERVAL_MS = 60_000

export interface ReaperDeps {
  sessions: Pick<ISessionManager, 'liveSessions' | 'reap'>
  store: ISessionStore
  config: IConfigStore
  viewers: (sessionId: string) => number
  logger?: RunLogger
  now?: () => number
}

export interface SessionReaper {
  /** Evaluate every live session once against the policy; returns reaped ids. */
  tick(): string[]
  start(): void
  stop(): void
}

function coerce(partial: unknown): GcPolicy {
  const p = (partial ?? {}) as Partial<GcPolicy>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_GC_POLICY.enabled,
    onlyAbandoned: typeof p.onlyAbandoned === 'boolean' ? p.onlyAbandoned : DEFAULT_GC_POLICY.onlyAbandoned,
    autoStopOnDone: typeof p.autoStopOnDone === 'boolean' ? p.autoStopOnDone : DEFAULT_GC_POLICY.autoStopOnDone,
    idleMs: Number.isFinite(p.idleMs) && (p.idleMs as number) >= 0 ? (p.idleMs as number) : DEFAULT_GC_POLICY.idleMs,
    maxAgeMs: Number.isFinite(p.maxAgeMs) && (p.maxAgeMs as number) >= 0 ? (p.maxAgeMs as number) : DEFAULT_GC_POLICY.maxAgeMs,
  }
}

/** Read the GC policy from the config store, falling back per-field to defaults. */
export function readGcPolicy(config: IConfigStore): GcPolicy {
  const raw = config.get(GC_POLICY_KEY)
  if (!raw) return { ...DEFAULT_GC_POLICY }
  try {
    return coerce(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_GC_POLICY }
  }
}

/** Normalize and persist a GC policy. */
export function writeGcPolicy(config: IConfigStore, policy: GcPolicy): void {
  config.set(GC_POLICY_KEY, JSON.stringify(coerce(policy)))
}

export function createSessionReaper(deps: ReaperDeps): SessionReaper {
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null

  function reapOne(info: LiveSessionInfo, reason: string): void {
    deps.sessions.reap(info.id)
    const persisted = deps.store.get(info.id)
    if (persisted) deps.store.upsert({ ...persisted, status: 'reaped' })
    deps.logger?.server('info', 'session reaped', { sessionId: info.id, reason, prevStatus: info.status })
  }

  function tick(): string[] {
    const policy = readGcPolicy(deps.config)
    if (!policy.enabled) return []
    const t = now()
    const reaped: string[] = []
    for (const info of deps.sessions.liveSessions()) {
      if (policy.onlyAbandoned && deps.viewers(info.id) > 0) continue

      let reason: string | null = null
      if (policy.autoStopOnDone && info.status === 'done') {
        reason = 'auto-stop: agent done'
      } else if (policy.maxAgeMs > 0 && t - info.createdAt >= policy.maxAgeMs) {
        reason = 'max age exceeded'
      } else if (policy.idleMs > 0 && t - info.lastActivityAt >= policy.idleMs) {
        reason = 'idle timeout'
      }

      if (reason) {
        reapOne(info, reason)
        reaped.push(info.id)
      }
    }
    return reaped
  }

  function start(): void {
    if (timer) return
    timer = setInterval(() => {
      try { tick() } catch { /* never crash the daemon */ }
    }, REAP_INTERVAL_MS)
    timer.unref?.()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { tick, start, stop }
}
