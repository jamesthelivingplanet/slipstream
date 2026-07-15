/**
 * Unit tests for the nativeStorage facade (TASK-I9S44). Mirrors the
 * globalThis.window/localStorage stubbing pattern in push.test.ts and
 * wsApi.test.ts. Covers:
 *  - isNativeShell() feature detection
 *  - get/set/remove fallback order: secure storage (token only) → Preferences
 *    → localStorage, tolerating any tier being absent or throwing
 *  - migrateLegacy(): one-time copy-forward from a pre-existing localStorage
 *    key, and that it is idempotent once the new key is populated
 *  - restart(): best-effort AppControl.restart() call
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const TOKEN_KEY = 'slipstream.token'

// ── fake localStorage ───────────────────────────────────────────────────────

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

// ── fake Capacitor bridge ───────────────────────────────────────────────────

interface FakeCapacitorOptions {
  withPreferences?: boolean
  withSecureStorage?: boolean
  withAppControl?: boolean
  secureThrows?: boolean
  preferencesThrows?: boolean
}

function makeFakeCapacitor(opts: FakeCapacitorOptions = {}) {
  const prefsData = new Map<string, string>()
  const secureData = new Map<string, string>()

  const Preferences = opts.withPreferences
    ? {
        get: vi.fn(async ({ key }: { key: string }) => {
          if (opts.preferencesThrows) throw new Error('preferences boom')
          return { value: prefsData.get(key) ?? null }
        }),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
          if (opts.preferencesThrows) throw new Error('preferences boom')
          prefsData.set(key, value)
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
          prefsData.delete(key)
        }),
      }
    : undefined

  const SecureStorage = opts.withSecureStorage
    ? {
        getItem: vi.fn(async (key: string) => {
          if (opts.secureThrows) throw new Error('secure boom')
          return secureData.get(key) ?? null
        }),
        setItem: vi.fn(async (key: string, value: string) => {
          if (opts.secureThrows) throw new Error('secure boom')
          secureData.set(key, value)
        }),
        removeItem: vi.fn(async (key: string) => {
          secureData.delete(key)
        }),
      }
    : undefined

  const AppControl = opts.withAppControl
    ? { restart: vi.fn().mockResolvedValue(undefined) }
    : undefined

  return {
    isPluginAvailable: vi.fn(() => true),
    Plugins: { Preferences, SecureStorage, AppControl },
    _prefsData: prefsData,
    _secureData: secureData,
    _Preferences: Preferences,
    _SecureStorage: SecureStorage,
    _AppControl: AppControl,
  }
}

function stubBrowserGlobals(capacitor?: ReturnType<typeof makeFakeCapacitor>) {
  const win = { Capacitor: capacitor } as unknown
  ;(globalThis as { window?: unknown }).window = win
  ;(globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage()
}

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
})

async function loadModule() {
  return import('./nativeStorage.js')
}

// ── isNativeShell ────────────────────────────────────────────────────────────

describe('isNativeShell', () => {
  it('is false when window.Capacitor is absent (plain browser/Electron)', async () => {
    stubBrowserGlobals(undefined)
    const { isNativeShell } = await loadModule()
    expect(isNativeShell()).toBe(false)
  })

  it('is true when window.Capacitor is present', async () => {
    stubBrowserGlobals(makeFakeCapacitor())
    const { isNativeShell } = await loadModule()
    expect(isNativeShell()).toBe(true)
  })
})

// ── get/set/remove fallback order ───────────────────────────────────────────

describe('nativeStorage.get/set on a plain browser (no Capacitor)', () => {
  it('reads and writes localStorage directly', async () => {
    stubBrowserGlobals(undefined)
    const { nativeStorage } = await loadModule()

    expect(await nativeStorage.get('some.key')).toBeNull()
    await nativeStorage.set('some.key', 'value-1')
    expect(await nativeStorage.get('some.key')).toBe('value-1')
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem('some.key'),
    ).toBe('value-1')
  })
})

describe('nativeStorage.get/set inside the native shell', () => {
  it('writes a non-token key to Preferences, not localStorage', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set('slipstream.daemonUrl', 'https://example.com')
    expect(cap._prefsData.get('slipstream.daemonUrl')).toBe('https://example.com')
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
        'slipstream.daemonUrl',
      ),
    ).toBeNull()

    expect(await nativeStorage.get('slipstream.daemonUrl')).toBe('https://example.com')
  })

  it('writes the token key to secure storage when available, not Preferences', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, withSecureStorage: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set(TOKEN_KEY, 'tok-123')
    expect(cap._secureData.get(TOKEN_KEY)).toBe('tok-123')
    expect(cap._prefsData.has(TOKEN_KEY)).toBe(false)
    expect(await nativeStorage.get(TOKEN_KEY)).toBe('tok-123')
  })

  it('falls back to Preferences for the token when secure storage is absent (downgrade case)', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, withSecureStorage: false })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set(TOKEN_KEY, 'tok-456')
    expect(cap._prefsData.get(TOKEN_KEY)).toBe('tok-456')
  })

  it('falls back to Preferences when secure storage throws', async () => {
    const cap = makeFakeCapacitor({
      withPreferences: true,
      withSecureStorage: true,
      secureThrows: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set(TOKEN_KEY, 'tok-789')
    expect(cap._prefsData.get(TOKEN_KEY)).toBe('tok-789')

    expect(await nativeStorage.get(TOKEN_KEY)).toBe('tok-789')
  })

  it('falls back to localStorage when the bridge exists but no plugin is available (old APK)', async () => {
    const cap = makeFakeCapacitor({ withPreferences: false, withSecureStorage: false })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set('slipstream.fcm', '{"token":"x","enabled":true}')
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem('slipstream.fcm'),
    ).toBe('{"token":"x","enabled":true}')
    expect(await nativeStorage.get('slipstream.fcm')).toBe('{"token":"x","enabled":true}')
  })

  it('falls back to localStorage when Preferences.get throws', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, preferencesThrows: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'some.key',
      'from-localstorage',
    )
    expect(await nativeStorage.get('some.key')).toBe('from-localstorage')
  })
})

describe('nativeStorage.remove', () => {
  it('clears every tier including an explicit legacy key', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, withSecureStorage: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set(TOKEN_KEY, 'tok-abc')
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'legacy_token',
      'old-value',
    )

    await nativeStorage.remove(TOKEN_KEY, 'legacy_token')

    expect(cap._secureData.has(TOKEN_KEY)).toBe(false)
    expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem('legacy_token'),
    ).toBeNull()
  })
})

// ── migrateLegacy ────────────────────────────────────────────────────────────

describe('nativeStorage.migrateLegacy', () => {
  it('copies a legacy localStorage value forward when the new key is empty', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, withSecureStorage: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'legacy_token',
      'legacy-value',
    )

    await nativeStorage.migrateLegacy(TOKEN_KEY, 'legacy_token')

    expect(await nativeStorage.get(TOKEN_KEY)).toBe('legacy-value')
    // The legacy copy is intentionally left in place.
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem('legacy_token'),
    ).toBe('legacy-value')
  })

  it('applies a transform to the legacy value', async () => {
    stubBrowserGlobals(undefined)
    const { nativeStorage } = await loadModule()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'slipstream.fcmToken',
      'raw-token',
    )

    await nativeStorage.migrateLegacy('slipstream.fcm', 'slipstream.fcmToken', (legacy) =>
      JSON.stringify({ token: legacy, enabled: true }),
    )

    expect(await nativeStorage.get('slipstream.fcm')).toBe(
      JSON.stringify({ token: 'raw-token', enabled: true }),
    )
  })

  it('is a no-op once the new key is already populated', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, withSecureStorage: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    await nativeStorage.set(TOKEN_KEY, 'current-value')
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'legacy_token',
      'stale-legacy-value',
    )

    await nativeStorage.migrateLegacy(TOKEN_KEY, 'legacy_token')

    expect(await nativeStorage.get(TOKEN_KEY)).toBe('current-value')
  })

  it('is a no-op when neither the new key nor the legacy key has a value', async () => {
    stubBrowserGlobals(undefined)
    const { nativeStorage } = await loadModule()
    await nativeStorage.migrateLegacy(TOKEN_KEY, 'legacy_token')
    expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()
  })

  it('does not resurrect a value after remove() clears both tiers (logout must stick)', async () => {
    const cap = makeFakeCapacitor({ withPreferences: true, withSecureStorage: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'legacy_token',
      'legacy-value',
    )

    await nativeStorage.migrateLegacy(TOKEN_KEY, 'legacy_token')
    expect(await nativeStorage.get(TOKEN_KEY)).toBe('legacy-value')

    await nativeStorage.remove(TOKEN_KEY, 'legacy_token')
    await nativeStorage.migrateLegacy(TOKEN_KEY, 'legacy_token')

    expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()
  })
})

// ── restart ──────────────────────────────────────────────────────────────────

describe('nativeStorage.restart', () => {
  it('is a no-op outside the native shell', async () => {
    stubBrowserGlobals(undefined)
    const { nativeStorage } = await loadModule()
    await expect(nativeStorage.restart()).resolves.toBeUndefined()
  })

  it('is a no-op when the bridge exists but AppControl was not registered (old APK)', async () => {
    stubBrowserGlobals(makeFakeCapacitor({ withAppControl: false }))
    const { nativeStorage } = await loadModule()
    await expect(nativeStorage.restart()).resolves.toBeUndefined()
  })

  it('calls AppControl.restart() when available', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    await nativeStorage.restart()
    expect(cap._AppControl?.restart).toHaveBeenCalledOnce()
  })

  it('swallows a throw from AppControl.restart()', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap)
    cap._AppControl?.restart.mockRejectedValueOnce(new Error('boom'))
    const { nativeStorage } = await loadModule()
    await expect(nativeStorage.restart()).resolves.toBeUndefined()
  })
})
