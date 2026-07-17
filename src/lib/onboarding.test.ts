/**
 * Unit tests for onboarding.ts (TASK-EQOP4). Mirrors the globalThis.window/
 * localStorage stubbing pattern in nativeStorage.test.ts, since initOnboarding/
 * markOnboardingSeen go through the real nativeStorage facade.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { get } from 'svelte/store'

const SEEN_KEY = 'slipstream.onboardingSeen'

function makeFakeLocalStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => data.clear(),
  }
}

function stubBrowserGlobals() {
  ;(globalThis as { window?: unknown }).window = {}
  ;(globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage()
}

afterEach(() => {
  vi.resetModules()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
})

async function loadModule() {
  return import('./onboarding.js')
}

describe('onboardingMode', () => {
  it('returns pager when the Capacitor shell is available', async () => {
    const { onboardingMode } = await loadModule()
    expect(onboardingMode(true)).toBe('pager')
  })

  it('returns modal everywhere else (plain browser, PWA, Electron)', async () => {
    const { onboardingMode } = await loadModule()
    expect(onboardingMode(false)).toBe('modal')
  })
})

describe('ONBOARDING_SEEN_KEY', () => {
  it('is slipstream.onboardingSeen', async () => {
    const { ONBOARDING_SEEN_KEY } = await loadModule()
    expect(ONBOARDING_SEEN_KEY).toBe(SEEN_KEY)
  })
})

describe('initOnboarding', () => {
  it('shows onboarding on a first boot (nothing persisted yet)', async () => {
    stubBrowserGlobals()
    const { initOnboarding, onboardingVisible } = await loadModule()
    await initOnboarding()
    expect(get(onboardingVisible)).toBe(true)
  })

  it('stays hidden once the seen-flag is persisted', async () => {
    stubBrowserGlobals()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(SEEN_KEY, '1')
    const { initOnboarding, onboardingVisible } = await loadModule()
    await initOnboarding()
    expect(get(onboardingVisible)).toBe(false)
  })

  it('only fetches once across repeated calls', async () => {
    stubBrowserGlobals()
    const { initOnboarding } = await loadModule()
    const p1 = initOnboarding()
    const p2 = initOnboarding()
    expect(p1).toBe(p2)
    await p1
  })
})

describe('markOnboardingSeen', () => {
  it('hides onboarding and persists the seen-flag', async () => {
    stubBrowserGlobals()
    const { initOnboarding, markOnboardingSeen, onboardingVisible } = await loadModule()
    await initOnboarding()
    expect(get(onboardingVisible)).toBe(true)

    await markOnboardingSeen()
    expect(get(onboardingVisible)).toBe(false)
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(SEEN_KEY),
    ).toBe('1')
  })
})

describe('replayOnboarding', () => {
  it('shows onboarding again even though it was already marked seen', async () => {
    stubBrowserGlobals()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(SEEN_KEY, '1')
    const { initOnboarding, replayOnboarding, onboardingVisible } = await loadModule()
    await initOnboarding()
    expect(get(onboardingVisible)).toBe(false)

    replayOnboarding()
    expect(get(onboardingVisible)).toBe(true)
  })

  it('leaves the persisted seen-flag untouched (idempotent dismiss re-persists the same value)', async () => {
    stubBrowserGlobals()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(SEEN_KEY, '1')
    const { replayOnboarding } = await loadModule()
    replayOnboarding()
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(SEEN_KEY),
    ).toBe('1')
  })
})
