/**
 * Unit tests for the home-screen widget sync bridge (TASK-DM25C). Mirrors
 * the fake-Capacitor / fake-timers approach in push.test.ts: window.Capacitor
 * is only ever present inside the mobile shell, so subscribeWidgetSync()
 * must feature-detect it and no-op everywhere else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Session } from './types'

vi.mock('./stores', async () => {
  const { writable } = await import('svelte/store')
  return { sessions: writable<Session[]>([]) }
})

import { subscribeWidgetSync } from './widgetSync.js'
import { sessions as sessionsStore } from './stores'

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    tid: overrides.id,
    src: 'linear',
    status: 'idle',
    title: `Session ${overrides.id}`,
    repo: null,
    branch: null,
    add: 0,
    del: 0,
    behind: 0,
    ago: 'now',
    activity: { text: '' },
    ...overrides,
  }
}

function makeFakeCapacitor(opts: { pluginAvailable?: boolean } = {}) {
  const syncWidget = vi.fn().mockResolvedValue(undefined)
  return {
    isPluginAvailable: vi.fn((name: string) =>
      opts.pluginAvailable === false ? false : name === 'AppControl',
    ),
    Plugins: { AppControl: { syncWidget } },
    _syncWidget: syncWidget,
  }
}

describe('widgetSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionsStore.set([])
    // @ts-expect-error test-only global stub
    delete globalThis.window
  })

  afterEach(() => {
    vi.useRealTimers()
    // @ts-expect-error test-only global stub
    delete globalThis.window
  })

  it('no-ops when window.Capacitor is absent (plain browser / Electron)', () => {
    // @ts-expect-error minimal window stub
    globalThis.window = {}
    const unsub = subscribeWidgetSync()
    sessionsStore.set([makeSession({ id: 'a' })])
    vi.advanceTimersByTime(10000)
    unsub()
  })

  it('no-ops when the AppControl plugin is unavailable', () => {
    const capacitor = makeFakeCapacitor({ pluginAvailable: false })
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetSync()
    sessionsStore.set([makeSession({ id: 'a' })])
    vi.advanceTimersByTime(10000)
    expect(capacitor._syncWidget).not.toHaveBeenCalled()
    unsub()
  })

  it('debounces rapid updates into a single syncWidget call, sorted needs > running > done > idle', () => {
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetSync()

    sessionsStore.set([makeSession({ id: 'a', status: 'done' })])
    vi.advanceTimersByTime(1000)
    sessionsStore.set([
      makeSession({ id: 'a', status: 'done' }),
      makeSession({ id: 'b', status: 'needs' }),
    ])
    vi.advanceTimersByTime(1000)
    sessionsStore.set([
      makeSession({ id: 'a', status: 'done' }),
      makeSession({ id: 'b', status: 'needs' }),
      makeSession({ id: 'c', status: 'running' }),
    ])

    expect(capacitor._syncWidget).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4000)

    expect(capacitor._syncWidget).toHaveBeenCalledTimes(1)
    const call = capacitor._syncWidget.mock.calls[0][0] as {
      sessionsJson: string
      updatedAt: number
    }
    const parsed = JSON.parse(call.sessionsJson)
    expect(parsed.map((s: { id: string }) => s.id)).toEqual(['b', 'c', 'a'])
    expect(parsed[0].bucket).toBe('needs')
    expect(typeof call.updatedAt).toBe('number')

    unsub()
  })

  it('omits sessions without a backend id and caps the list at 20', () => {
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetSync()

    const many = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: `s${i}`, status: 'running' }),
    )
    sessionsStore.set([{ ...makeSession({ id: 'draft' }), id: undefined }, ...many])
    vi.advanceTimersByTime(4000)

    const call = capacitor._syncWidget.mock.calls[0][0] as { sessionsJson: string }
    const parsed = JSON.parse(call.sessionsJson)
    expect(parsed).toHaveLength(20)
    expect(parsed.every((s: { id: string }) => s.id.startsWith('s'))).toBe(true)

    unsub()
  })

  it('stops syncing after unsubscribe', () => {
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetSync()
    unsub()

    sessionsStore.set([makeSession({ id: 'a' })])
    vi.advanceTimersByTime(10000)

    expect(capacitor._syncWidget).not.toHaveBeenCalled()
  })
})
