import { writable, get } from 'svelte/store'
import { genId } from './id.js'

export type ToastType = 'success' | 'error' | 'warning'

export interface Toast {
  id: string
  type: ToastType
  message: string
}

/**
 * Auto-dismiss delay per type, in ms. `0` means the toast persists until the
 * user dismisses it (FLO-115). `error`/`warning` toasts carry information the
 * user often needs to read in full or copy — the stash-conflict warning in
 * `updateAgentFromBase` is the canonical example — so they never vanish on
 * their own; they only go away via the explicit × button. `success` toasts
 * are ephemeral confirmations and still clear themselves after 4s.
 */
const AUTO_DISMISS_MS: Record<ToastType, number> = {
  success: 4000,
  error: 0,
  warning: 0,
}

export const toasts = writable<Toast[]>([])

/**
 * Per-toast auto-dismiss bookkeeping. A persistent toast (TTL 0) has no entry.
 * Pause-on-hover clears the running timer and banks the remaining ms; resume
 * re-schedules it. `startedAt === 0` marks a paused timer (FLO-115).
 */
interface Timer {
  timeout: ReturnType<typeof setTimeout> | null
  remaining: number
  startedAt: number
}
const timers = new Map<string, Timer>()

function scheduleTimeout(id: string, ms: number): void {
  const timeout = setTimeout(() => dismissToast(id), ms)
  timers.set(id, { timeout, remaining: ms, startedAt: Date.now() })
}

/**
 * Push a toast. Repeated identical toasts (same type + message) are deduped so
 * a flaky operation spamming the same failure — or the status pipeline ping-
 * ponging — surfaces a single notification instead of a stack of copies
 * (FLO-115). Returns the id of the toast now on screen (the existing one on a
 * dedupe hit, otherwise the newly created one).
 */
export function pushToast(type: ToastType, message: string): string {
  const existing = get(toasts).find((t) => t.type === type && t.message === message)
  if (existing) return existing.id

  const id = genId()
  toasts.update(($t) => [...$t, { id, type, message }])
  const ttl = AUTO_DISMISS_MS[type]
  if (ttl > 0) scheduleTimeout(id, ttl)
  return id
}

/** Remove a toast and tear down any auto-dismiss timer (FLO-115). */
export function dismissToast(id: string): void {
  const timer = timers.get(id)
  if (timer) {
    if (timer.timeout) clearTimeout(timer.timeout)
    timers.delete(id)
  }
  toasts.update(($t) => $t.filter((t) => t.id !== id))
}

/**
 * Pause a timed toast's auto-dismiss (e.g. on hover) so a long message can be
 * read/copied before it disappears. No-op for persistent toasts and for a
 * timer that's already paused (FLO-115).
 */
export function pauseToast(id: string): void {
  const timer = timers.get(id)
  if (!timer || timer.startedAt === 0) return
  if (timer.timeout) clearTimeout(timer.timeout)
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
  timer.startedAt = 0
  timer.timeout = null
}

/**
 * Resume a paused toast's auto-dismiss (FLO-115). If the banked time has
 * already elapsed, the toast is dismissed immediately.
 */
export function resumeToast(id: string): void {
  const timer = timers.get(id)
  if (!timer || timer.startedAt !== 0) return
  if (timer.remaining <= 0) {
    dismissToast(id)
    return
  }
  scheduleTimeout(id, timer.remaining)
}
