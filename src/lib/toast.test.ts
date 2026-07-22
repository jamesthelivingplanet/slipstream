/**
 * Unit tests for the toast store (FLO-115): error/warning toasts persist until
 * dismissed (the stash-conflict warning must be readable/copyable), success
 * toasts auto-dismiss at 4s, pause-on-hover banks and restores the remaining
 * time, and repeated identical messages are deduped. The store drives timers
 * itself (not the component), so this covers the full lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { get } from 'svelte/store'
import { toasts, pushToast, dismissToast, pauseToast, resumeToast } from './toast.js'

function ids(): string[] {
  return get(toasts).map((t) => t.id)
}

describe('toast store', () => {
  beforeEach(() => {
    // Clear any toasts/timers left over from a prior test.
    for (const t of get(toasts)) dismissToast(t.id)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const t of get(toasts)) dismissToast(t.id)
  })

  it('pushes a toast onto the store', () => {
    pushToast('error', 'boom')
    expect(get(toasts)).toEqual([{ id: expect.any(String), type: 'error', message: 'boom' }])
  })

  it('auto-dismisses success toasts after 4s', () => {
    vi.useFakeTimers()
    pushToast('success', 'ok')
    expect(ids()).toHaveLength(1)

    vi.advanceTimersByTime(3999)
    expect(ids()).toHaveLength(1) // not yet
    vi.advanceTimersByTime(1)
    expect(ids()).toHaveLength(0) // dismissed at 4000ms
  })

  it('keeps error toasts on screen (no auto-dismiss)', () => {
    vi.useFakeTimers()
    pushToast('error', 'nope')
    vi.advanceTimersByTime(60_000)
    expect(ids()).toHaveLength(1)
  })

  it('keeps warning toasts on screen (no auto-dismiss)', () => {
    vi.useFakeTimers()
    pushToast('warning', 'careful')
    vi.advanceTimersByTime(60_000)
    expect(ids()).toHaveLength(1)
  })

  it('dismissToast removes the toast and cancels its timer', () => {
    vi.useFakeTimers()
    const id = pushToast('success', 'bye')
    dismissToast(id)
    expect(ids()).toHaveLength(0)
    // Timer was cancelled: advancing does not throw and store stays empty.
    vi.advanceTimersByTime(10_000)
    expect(ids()).toHaveLength(0)
  })

  describe('dedupe', () => {
    it('collapses repeated identical (type + message) toasts into one', () => {
      const a = pushToast('error', 'Failed to save settings')
      const b = pushToast('error', 'Failed to save settings')
      expect(b).toBe(a)
      expect(ids()).toHaveLength(1)
    })

    it('treats the same message with a different type as distinct', () => {
      pushToast('error', 'disk full')
      pushToast('warning', 'disk full')
      expect(ids()).toHaveLength(2)
    })

    it('treats a different message as distinct', () => {
      pushToast('error', 'one')
      pushToast('error', 'two')
      expect(ids()).toHaveLength(2)
    })

    it('re-shows a message after the earlier identical toast is dismissed', () => {
      const first = pushToast('error', 'again')
      dismissToast(first)
      const second = pushToast('error', 'again')
      expect(second).not.toBe(first)
      expect(ids()).toHaveLength(1)
    })
  })

  describe('pause / resume (pause-on-hover)', () => {
    it('a paused success toast does not auto-dismiss while paused', () => {
      vi.useFakeTimers()
      const id = pushToast('success', 'pause me')
      vi.advanceTimersByTime(2000) // 2s of the 4s elapsed
      pauseToast(id)
      vi.advanceTimersByTime(60_000) // paused → frozen
      expect(ids()).toHaveLength(1)
    })

    it('resuming re-schedules the banked remaining time', () => {
      vi.useFakeTimers()
      const id = pushToast('success', 'pause me')
      vi.advanceTimersByTime(2000) // 2s elapsed → ~2s remaining
      pauseToast(id)
      vi.advanceTimersByTime(60_000) // hold for a long time while paused

      resumeToast(id)
      vi.advanceTimersByTime(1999)
      expect(ids()).toHaveLength(1) // not yet
      vi.advanceTimersByTime(1)
      expect(ids()).toHaveLength(0) // dismissed at the banked ~2s
    })

    it('pause then resume is idempotent (no early dismissal)', () => {
      vi.useFakeTimers()
      const id = pushToast('success', 'double pause')
      pauseToast(id)
      pauseToast(id) // second pause is a no-op
      resumeToast(id)
      resumeToast(id) // second resume is a no-op
      expect(ids()).toHaveLength(1)
      vi.advanceTimersByTime(4000)
      expect(ids()).toHaveLength(0)
    })

    it('pauseToast/resumeToast are no-ops on persistent error toasts', () => {
      vi.useFakeTimers()
      const id = pushToast('error', 'stays put')
      pauseToast(id) // no timer → no-op
      resumeToast(id) // no paused timer → no-op
      vi.advanceTimersByTime(60_000)
      expect(ids()).toHaveLength(1)
    })
  })
})
