/**
 * Unit tests for the native haptics bridge (FLO-161). Mirrors the
 * fake-Capacitor approach in widgetSync.test.ts/push.test.ts: window.Capacitor
 * is only ever present inside the mobile shell, so buzzNeedsYou() must
 * feature-detect it and no-op everywhere else (and outside the foreground).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hapticsAvailable, buzzNeedsYou } from './haptics.js'

function makeFakeCapacitor(
  opts: { pluginAvailable?: boolean; impactImpl?: () => Promise<void> } = {},
) {
  const impact = vi.fn(opts.impactImpl ?? (() => Promise.resolve(undefined)))
  return {
    isPluginAvailable: vi.fn((name: string) =>
      opts.pluginAvailable === false ? false : name === 'Haptics',
    ),
    Plugins: { Haptics: { impact } },
    _impact: impact,
  }
}

describe('haptics', () => {
  beforeEach(() => {
    // @ts-expect-error test-only global stub
    delete globalThis.window
    // @ts-expect-error test-only global stub
    delete globalThis.document
  })

  afterEach(() => {
    // @ts-expect-error test-only global stub
    delete globalThis.window
    // @ts-expect-error test-only global stub
    delete globalThis.document
  })

  describe('hapticsAvailable', () => {
    it('is false when window is absent (plain browser tab loading the same bundle / Electron)', () => {
      expect(hapticsAvailable()).toBe(false)
    })

    it('is false when window.Capacitor exists but Haptics is unavailable', () => {
      const capacitor = makeFakeCapacitor({ pluginAvailable: false })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      expect(hapticsAvailable()).toBe(false)
    })

    it('is true when the Capacitor bridge reports Haptics available', () => {
      const capacitor = makeFakeCapacitor()
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      expect(hapticsAvailable()).toBe(true)
    })
  })

  describe('buzzNeedsYou', () => {
    it('no-ops when window.Capacitor is absent', () => {
      expect(() => buzzNeedsYou()).not.toThrow()
    })

    it('no-ops when the Haptics plugin is unavailable', () => {
      const capacitor = makeFakeCapacitor({ pluginAvailable: false })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      buzzNeedsYou()
      expect(capacitor._impact).not.toHaveBeenCalled()
    })

    it('fires a single MEDIUM impact when available and foregrounded (no document = assumed foreground)', () => {
      const capacitor = makeFakeCapacitor()
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      buzzNeedsYou()
      expect(capacitor._impact).toHaveBeenCalledTimes(1)
      expect(capacitor._impact).toHaveBeenCalledWith({ style: 'MEDIUM' })
    })

    it('fires when document.visibilityState is visible', () => {
      const capacitor = makeFakeCapacitor()
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      // @ts-expect-error minimal document stub
      globalThis.document = { visibilityState: 'visible' }
      buzzNeedsYou()
      expect(capacitor._impact).toHaveBeenCalledTimes(1)
    })

    it('does not fire when the app is backgrounded (document.visibilityState hidden)', () => {
      const capacitor = makeFakeCapacitor()
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      // @ts-expect-error minimal document stub
      globalThis.document = { visibilityState: 'hidden' }
      buzzNeedsYou()
      expect(capacitor._impact).not.toHaveBeenCalled()
    })

    it('swallows a rejected impact() call rather than throwing', async () => {
      const capacitor = makeFakeCapacitor({ impactImpl: () => Promise.reject(new Error('nope')) })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: capacitor }
      expect(() => buzzNeedsYou()).not.toThrow()
      // let the rejected promise's .catch() settle before the test ends
      await new Promise((r) => setTimeout(r, 0))
    })
  })
})
