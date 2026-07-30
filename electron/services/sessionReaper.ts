/**
 * SessionReaper — FLO-52 session GC / cost guard.
 *
 * Periodically evaluates every live PTY session against the configured
 * GcPolicy and reaps (kills + marks 'reaped') sessions that are abandoned,
 * idle too long, too old, or done with autoStopOnDone set. Pure, node-runnable
 * — only depends on the ISessionManager/ISessionStore/IConfigStore interfaces
 * (fakes in tests), never node-pty/better-sqlite3 directly.
 */

import type {
  BudgetPolicy,
  GcPolicy,
  ISessionManager,
  ISessionStore,
  LiveSessionInfo,
  SessionDTO,
  SessionUsage,
} from '../shared/contract.js'
import { DEFAULT_BUDGET_POLICY, DEFAULT_GC_POLICY } from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import type { RunLogger } from './runLogger.js'
import { readSessionUsage } from './usage.js'
import { formatCost } from '../shared/usageFormat.js'

const GC_POLICY_KEY = 'gc.policy'
const BUDGET_POLICY_KEY = 'budget.policy'
const REAP_INTERVAL_MS = 60_000

export interface ReaperDeps {
  sessions: Pick<ISessionManager, 'liveSessions' | 'reap'>
  store: ISessionStore
  config: IConfigStore
  viewers: (sessionId: string) => number
  logger?: RunLogger
  now?: () => number
  /** Injectable per-session usage reader for the BudgetPolicy per-session
   *  cap. Defaults to the real `readSessionUsage(session, { cwd: null })`.
   *
   *  Why `cwd: null` always: this service's deps are deliberately
   *  interface-only (sessions/store/config/viewers/logger — no repo/
   *  worktree resolver, see the module doc above), so it cannot look up a
   *  session's worktree cwd. `pi`'s usage reader is keyed on that cwd, so a
   *  `pi` session's real cost is invisible to this cap in practice — even
   *  though `pi` has `supportsUsage: true` (AGENT_META). This is a known,
   *  accepted gap distinct from the grok/kilo/antigravity gap (those simply
   *  have no reader at all, see budgetReasonFor below) — surfaced to the
   *  user via the Settings UI, not silently papered over. Tests inject a
   *  fake so the cap can be exercised without touching the real filesystem. */
  getSessionUsage?: (session: SessionDTO) => Promise<SessionUsage & { supportsUsage: boolean }>
}

export interface SessionReaper {
  /** Evaluate every live session once against the policy; returns reaped ids. */
  tick(): Promise<string[]>
  start(): void
  stop(): void
}

function coerce(partial: unknown): GcPolicy {
  const p = (partial ?? {}) as Partial<GcPolicy>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_GC_POLICY.enabled,
    onlyAbandoned:
      typeof p.onlyAbandoned === 'boolean' ? p.onlyAbandoned : DEFAULT_GC_POLICY.onlyAbandoned,
    autoStopOnDone:
      typeof p.autoStopOnDone === 'boolean' ? p.autoStopOnDone : DEFAULT_GC_POLICY.autoStopOnDone,
    idleMs:
      Number.isFinite(p.idleMs) && (p.idleMs as number) >= 0
        ? (p.idleMs as number)
        : DEFAULT_GC_POLICY.idleMs,
    maxAgeMs:
      Number.isFinite(p.maxAgeMs) && (p.maxAgeMs as number) >= 0
        ? (p.maxAgeMs as number)
        : DEFAULT_GC_POLICY.maxAgeMs,
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

/** Coerce a partial/untrusted value into a well-formed BudgetPolicy,
 *  field-by-field falling back to DEFAULT_BUDGET_POLICY. Cap fields are USD
 *  amounts (not counts), so they're clamped at 0 without being floored to an
 *  integer the way GcPolicy's ms fields are (a $3.50 cap must stay $3.50). */
function coerceBudget(partial: unknown): BudgetPolicy {
  const p = (partial ?? {}) as Partial<BudgetPolicy>
  const cap = (raw: unknown, def: number): number => {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : def
    return Math.max(0, n)
  }
  return {
    dailyUsdCap: cap(p.dailyUsdCap, DEFAULT_BUDGET_POLICY.dailyUsdCap),
    perSessionUsdCap: cap(p.perSessionUsdCap, DEFAULT_BUDGET_POLICY.perSessionUsdCap),
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_BUDGET_POLICY.enabled,
  }
}

/** Read the cost-budget policy from the config store, falling back per-field
 *  to defaults. Narrower param type than IConfigStore so callers with only
 *  read access (e.g. agentSpawnService.ts's `Pick<IConfigStore, 'get'>` dep)
 *  can call this directly instead of duplicating the coerce/read logic. */
export function readBudgetPolicy(config: Pick<IConfigStore, 'get'>): BudgetPolicy {
  const raw = config.get(BUDGET_POLICY_KEY)
  if (!raw) return { ...DEFAULT_BUDGET_POLICY }
  try {
    return coerceBudget(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_BUDGET_POLICY }
  }
}

/** Normalize and persist a cost-budget policy. */
export function writeBudgetPolicy(config: Pick<IConfigStore, 'set'>, policy: BudgetPolicy): void {
  config.set(BUDGET_POLICY_KEY, JSON.stringify(coerceBudget(policy)))
}

export function createSessionReaper(deps: ReaperDeps): SessionReaper {
  const now = deps.now ?? Date.now
  const getSessionUsage =
    deps.getSessionUsage ?? ((s: SessionDTO) => readSessionUsage(s, { cwd: null }))
  let timer: ReturnType<typeof setInterval> | null = null

  function reapOne(info: LiveSessionInfo, reason: string): void {
    deps.sessions.reap(info.id)
    const persisted = deps.store.get(info.id)
    if (persisted) deps.store.upsert({ ...persisted, status: 'reaped' })
    deps.logger?.server('info', 'session reaped', {
      sessionId: info.id,
      reason,
      prevStatus: info.status,
    })
  }

  // Per-session cost check, run only for BudgetPolicy.perSessionUsdCap.
  //
  // CRITICAL honesty requirement: a backend with no usage reader at all
  // (supportsUsage:false — currently grok/kilo/antigravity, per AGENT_META)
  // reports costUsd:0 from readSessionUsage, and that zero is NOT "this
  // session is free" — it means "unknowable to this app" (see usage.ts's own
  // doc comment on readSessionUsage). This function therefore SKIPS
  // enforcement (returns null, no reap) for supportsUsage:false sessions
  // rather than either (a) treating the fabricated zero as proof of
  // compliance in a way that pretends the cap is comprehensive, or (b)
  // inventing a cost. This is a real, documented gap in the cap's coverage,
  // surfaced to the user via the Settings UI (a separate change) — not
  // silently papered over. Never fabricate a cost number: this app is
  // real-data-only.
  async function budgetReasonFor(info: LiveSessionInfo, cap: number): Promise<string | null> {
    const session = deps.store.get(info.id)
    if (!session) return null
    const usage = await getSessionUsage(session)
    if (!usage.supportsUsage) return null
    if (usage.costUsd >= cap) {
      return `budget: per-session cap exceeded (est. ${formatCost(usage.costUsd)} ≥ ${formatCost(cap)} cap)`
    }
    return null
  }

  async function tick(): Promise<string[]> {
    // GcPolicy and BudgetPolicy are two INDEPENDENT policies with independent
    // `enabled` switches — read both up front so disabling one never
    // suppresses the other.
    const gcPolicy = readGcPolicy(deps.config)
    const budgetPolicy = readBudgetPolicy(deps.config)
    const budgetActive = budgetPolicy.enabled && budgetPolicy.perSessionUsdCap > 0
    if (!gcPolicy.enabled && !budgetActive) return []

    const t = now()
    const reaped: string[] = []
    for (const info of deps.sessions.liveSessions()) {
      let reason: string | null = null

      if (gcPolicy.enabled && !(gcPolicy.onlyAbandoned && deps.viewers(info.id) > 0)) {
        if (gcPolicy.autoStopOnDone && info.status === 'done') {
          reason = 'auto-stop: agent done'
        } else if (gcPolicy.maxAgeMs > 0 && t - info.createdAt >= gcPolicy.maxAgeMs) {
          reason = 'max age exceeded'
        } else if (gcPolicy.idleMs > 0 && t - info.lastActivityAt >= gcPolicy.idleMs) {
          reason = 'idle timeout'
        }
      }

      // Only run the (async) cost check when the session wasn't already
      // reaped for a GC reason — cheap short-circuit, avoids a wasted async
      // read. Deliberately does NOT respect gcPolicy.onlyAbandoned: a real
      // cost overrun should reap regardless of whether anyone's watching —
      // that gate is GC-policy-specific.
      if (!reason && budgetActive) {
        reason = await budgetReasonFor(info, budgetPolicy.perSessionUsdCap)
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
      tick().catch(() => {
        /* never crash the daemon */
      })
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
