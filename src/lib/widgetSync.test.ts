/**
 * Unit tests for the home-screen widget sync bridge (TASK-DM25C). Mirrors
 * the fake-Capacitor / fake-timers approach in push.test.ts: window.Capacitor
 * is only ever present inside the mobile shell, so subscribeWidgetSync()
 * must feature-detect it and no-op everywhere else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Session } from './types'

const repoByIdMock = vi.hoisted(() => vi.fn())
const openAgentByIdMock = vi.hoisted(() => vi.fn())

vi.mock('./stores', async () => {
  const { writable } = await import('svelte/store')
  return {
    sessions: writable<Session[]>([]),
    repoById: repoByIdMock,
    openAgentById: openAgentByIdMock,
  }
})

import { subscribeWidgetSync, subscribeWidgetAgentOpen } from './widgetSync.js'
import { sessions as sessionsStore } from './stores'

function makeSession(overrides: Partial<Session> & { id: string; tid?: string }): Session {
  return {
    tid: overrides.tid ?? overrides.id,
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
  const removeListener = vi.fn().mockResolvedValue(undefined)
  let openAgentListener: ((data: { agentId: string }) => void) | undefined
  const addListener = vi.fn((eventName: string, fn: (data: { agentId: string }) => void) => {
    if (eventName === 'openAgent') openAgentListener = fn
    return Promise.resolve({ remove: removeListener })
  })
  return {
    isPluginAvailable: vi.fn((name: string) =>
      opts.pluginAvailable === false ? false : name === 'AppControl',
    ),
    Plugins: { AppControl: { syncWidget, addListener } },
    _syncWidget: syncWidget,
    _addListener: addListener,
    _removeListener: removeListener,
    _fireOpenAgent: (agentId: string) => openAgentListener?.({ agentId }),
  }
}

describe('widgetSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionsStore.set([])
    repoByIdMock.mockReset()
    repoByIdMock.mockReturnValue(undefined)
    openAgentByIdMock.mockReset()
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

  it('throttles rapid updates into a single syncWidget call, sorted needs > running > done > idle, with bucket counts', () => {
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
      snapshotJson: string
      updatedAt: number
    }
    const parsed = JSON.parse(call.snapshotJson)
    expect(parsed.sessions.map((s: { id: string }) => s.id)).toEqual(['b', 'c', 'a'])
    expect(parsed.sessions[0].bucket).toBe('needs')
    expect(parsed.counts).toEqual({ needs: 1, running: 1, done: 1 })
    expect(typeof call.updatedAt).toBe('number')

    unsub()
  })

  it('flushes at least once during continuous rapid updates (status-flapping starvation regression, see CLAUDE.md)', () => {
    // Simulates a chattering/flapping session re-emitting the sessions store
    // every 500ms for 5 seconds straight — the exact pattern CLAUDE.md's
    // "Session status flaps by design" gotcha describes (status pings every
    // few seconds on an idle TUI, indefinitely). Under the old
    // reset-on-every-change debounce, each emission cancels and restarts the
    // 4000ms timer, so a 4000ms *gap* between emissions never occurs and
    // flush() never fires — the widget goes stale for as long as the
    // flapping continues. The throttle fix must guarantee a flush at least
    // once every ~4s regardless of how continuously the store emits.
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetSync()

    for (let i = 0; i < 10; i++) {
      sessionsStore.set([makeSession({ id: 'a', status: i % 2 === 0 ? 'needs' : 'running' })])
      vi.advanceTimersByTime(500)
    }

    expect(capacitor._syncWidget).toHaveBeenCalled()

    unsub()
  })

  it('includes tid and resolves repo to "org/name" via repoById', () => {
    repoByIdMock.mockReturnValue({ id: 'r1', org: 'acme', name: 'widget', base: 'main' })
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetSync()

    sessionsStore.set([makeSession({ id: 'a', tid: 'TASK-1', repo: 'r1', status: 'running' })])
    vi.advanceTimersByTime(4000)

    const call = capacitor._syncWidget.mock.calls[0][0] as { snapshotJson: string }
    const parsed = JSON.parse(call.snapshotJson)
    expect(parsed.sessions[0].tid).toBe('TASK-1')
    expect(parsed.sessions[0].repo).toBe('acme/widget')

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

    const call = capacitor._syncWidget.mock.calls[0][0] as { snapshotJson: string }
    const parsed = JSON.parse(call.snapshotJson)
    expect(parsed.sessions).toHaveLength(20)
    expect(parsed.sessions.every((s: { id: string }) => s.id.startsWith('s'))).toBe(true)

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

describe('subscribeWidgetAgentOpen', () => {
  beforeEach(() => {
    openAgentByIdMock.mockReset()
    // @ts-expect-error test-only global stub
    delete globalThis.window
  })

  afterEach(() => {
    // @ts-expect-error test-only global stub
    delete globalThis.window
  })

  it('no-ops when window.Capacitor is absent (plain browser / Electron)', () => {
    // @ts-expect-error minimal window stub
    globalThis.window = {}
    const unsub = subscribeWidgetAgentOpen()
    unsub()
    expect(openAgentByIdMock).not.toHaveBeenCalled()
  })

  it('no-ops when the AppControl plugin is unavailable', () => {
    const capacitor = makeFakeCapacitor({ pluginAvailable: false })
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetAgentOpen()
    unsub()
    expect(capacitor._addListener).not.toHaveBeenCalled()
  })

  it('calls openAgentById with the id carried by a native openAgent event', async () => {
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetAgentOpen()
    await Promise.resolve()
    await Promise.resolve()

    capacitor._fireOpenAgent('s7k2')

    expect(openAgentByIdMock).toHaveBeenCalledWith('s7k2')
    unsub()
  })

  it('removes the listener on unsubscribe', async () => {
    const capacitor = makeFakeCapacitor()
    // @ts-expect-error minimal window stub
    globalThis.window = { Capacitor: capacitor }
    const unsub = subscribeWidgetAgentOpen()
    await Promise.resolve()
    await Promise.resolve()

    unsub()

    expect(capacitor._removeListener).toHaveBeenCalledTimes(1)
  })
})
