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
  // FLO-159: an older APK has AppControl but predates these two methods —
  // biometricPluginAvailable() (biometric.ts) feature-detects exactly that.
  withBiometric?: boolean
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
    ? {
        restart: vi.fn().mockResolvedValue(undefined),
        saveReplyCredentials: vi.fn().mockResolvedValue(undefined),
        clearReplyCredentials: vi.fn().mockResolvedValue(undefined),
        ...(opts.withBiometric
          ? {
              biometricAvailability: vi
                .fn()
                .mockResolvedValue({ available: true, status: 'available' }),
              biometricAuthenticate: vi.fn().mockResolvedValue({ authenticated: true }),
            }
          : {}),
      }
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

function stubBrowserGlobals(capacitor?: ReturnType<typeof makeFakeCapacitor>, origin?: string) {
  const win = { Capacitor: capacitor } as unknown
  ;(globalThis as { window?: unknown }).window = win
  ;(globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage()
  if (origin) {
    savedLocation = (globalThis as { location?: unknown }).location
    ;(globalThis as { location?: { origin: string } }).location = { origin }
  }
}

let savedLocation: unknown = undefined

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
  if (savedLocation !== undefined) {
    ;(globalThis as { location?: unknown }).location = savedLocation
    savedLocation = undefined
  }
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

// ── syncReplyCredentials (FLO-151) ─────────────────────────────────────────

describe('nativeStorage.syncReplyCredentials', () => {
  it('is a no-op when AppControl is unavailable (web/Electron)', async () => {
    stubBrowserGlobals(makeFakeCapacitor({ withAppControl: false }))
    const { nativeStorage } = await loadModule()
    await expect(nativeStorage.syncReplyCredentials()).resolves.toBeUndefined()
  })

  it('stashes the stored daemon-URL override + token when both are present', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap)
    const { nativeStorage, TOKEN_KEY, DAEMON_URL_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'tok-1')
    await nativeStorage.set(DAEMON_URL_KEY, 'https://slipstream.example.ts.net')
    vi.clearAllMocks()

    await nativeStorage.syncReplyCredentials()
    expect(cap._AppControl?.saveReplyCredentials).toHaveBeenCalledWith({
      url: 'https://slipstream.example.ts.net',
      token: 'tok-1',
    })
    expect(cap._AppControl?.clearReplyCredentials).not.toHaveBeenCalled()
  })

  it('falls back to location.origin when no daemon-URL override is stored', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap, 'http://100.64.0.1:7421')
    const { nativeStorage, TOKEN_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'tok-1')
    vi.clearAllMocks()

    await nativeStorage.syncReplyCredentials()
    expect(cap._AppControl?.saveReplyCredentials).toHaveBeenCalledWith({
      url: 'http://100.64.0.1:7421',
      token: 'tok-1',
    })
  })

  it('clears the stashed credentials when the token is missing', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap)
    const { nativeStorage, DAEMON_URL_KEY } = await loadModule()
    // Seed the URL directly in the fake prefs store (not via nativeStorage.set,
    // which would itself trigger a sync) so the only sync below is explicit.
    cap._prefsData.set(DAEMON_URL_KEY, 'https://example.com')
    vi.clearAllMocks()

    await nativeStorage.syncReplyCredentials()
    expect(cap._AppControl?.saveReplyCredentials).not.toHaveBeenCalled()
    expect(cap._AppControl?.clearReplyCredentials).toHaveBeenCalledOnce()
  })

  it('set(TOKEN_KEY) triggers a credential sync', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap, 'http://100.64.0.1:7421')
    const { nativeStorage, TOKEN_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'tok-1')
    // set() fires the sync fire-and-forget; flush it before asserting.
    await new Promise((r) => setTimeout(r, 0))
    expect(cap._AppControl?.saveReplyCredentials).toHaveBeenCalled()
  })

  it('remove(TOKEN_KEY) clears the stashed credentials (logout)', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap, 'http://100.64.0.1:7421')
    const { nativeStorage, TOKEN_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'tok-1')
    await new Promise((r) => setTimeout(r, 0)) // let the set-triggered sync settle
    vi.clearAllMocks()
    await nativeStorage.remove(TOKEN_KEY)
    await new Promise((r) => setTimeout(r, 0)) // flush the remove-triggered sync
    expect(cap._AppControl?.clearReplyCredentials).toHaveBeenCalled()
  })

  it('swallows a throw from AppControl.saveReplyCredentials', async () => {
    const cap = makeFakeCapacitor({ withAppControl: true })
    stubBrowserGlobals(cap, 'http://100.64.0.1:7421')
    cap._AppControl?.saveReplyCredentials.mockRejectedValueOnce(new Error('boom'))
    const { nativeStorage, TOKEN_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'tok-1')
    // No throw — the sync is best-effort.
    await expect(nativeStorage.syncReplyCredentials()).resolves.toBeUndefined()
  })
})

// ── Biometric token lock (FLO-159) ──────────────────────────────────────────
//
// Covers the get()-level gate (TOKEN_KEY reads null while locked) and the
// arm/lock/unlock state machine layered on top of it. Reuses
// makeFakeCapacitor/stubBrowserGlobals/loadModule from above — withBiometric
// adds the two AppControl methods biometric.ts feature-detects.

describe('biometric lock: get(TOKEN_KEY) gate', () => {
  it('returns null while locked, without touching secure storage or Preferences', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
      withSecureStorage: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage, TOKEN_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'secret-token')
    await nativeStorage.setBiometricLockEnabled(true)
    await nativeStorage.initBiometricLock()
    expect(nativeStorage.isTokenLocked()).toBe(true)
    vi.clearAllMocks()

    expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()
    expect(cap._SecureStorage?.getItem).not.toHaveBeenCalled()
    expect(cap._Preferences?.get).not.toHaveBeenCalled()
  })

  it('leaves other keys unaffected while locked', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage, TOKEN_KEY, DAEMON_URL_KEY } = await loadModule()
    await nativeStorage.set(TOKEN_KEY, 'secret-token')
    await nativeStorage.set(DAEMON_URL_KEY, 'https://example.com')
    await nativeStorage.setBiometricLockEnabled(true)
    await nativeStorage.initBiometricLock()

    expect(await nativeStorage.get(DAEMON_URL_KEY)).toBe('https://example.com')
  })
})

describe('biometric lock: initBiometricLock', () => {
  it('does not arm when the "require fingerprint" preference is off', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()

    const armed = await nativeStorage.initBiometricLock()

    expect(armed).toBe(false)
    expect(nativeStorage.isTokenLocked()).toBe(false)
  })

  it('does not arm outside the native shell', async () => {
    stubBrowserGlobals(undefined)
    const { nativeStorage } = await loadModule()

    const armed = await nativeStorage.initBiometricLock()

    expect(armed).toBe(false)
    expect(nativeStorage.isTokenLocked()).toBe(false)
  })

  it('does not arm when the plugin predates the biometric methods (older APK)', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: false,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    await nativeStorage.setBiometricLockEnabled(true)

    const armed = await nativeStorage.initBiometricLock()

    expect(armed).toBe(false)
    expect(nativeStorage.isTokenLocked()).toBe(false)
  })

  it('arms and locks when the shell, preference, and plugin all line up', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    await nativeStorage.setBiometricLockEnabled(true)

    const armed = await nativeStorage.initBiometricLock()

    expect(armed).toBe(true)
    expect(nativeStorage.isTokenLocked()).toBe(true)
  })
})

describe('biometric lock: unlockToken', () => {
  async function armAndLock(cap: ReturnType<typeof makeFakeCapacitor>) {
    stubBrowserGlobals(cap)
    const mod = await loadModule()
    await mod.nativeStorage.set(mod.TOKEN_KEY, 'secret-token')
    await mod.nativeStorage.setBiometricLockEnabled(true)
    await mod.nativeStorage.initBiometricLock()
    return mod
  }

  it('a successful unlock restores token reads', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    const { nativeStorage, TOKEN_KEY } = await armAndLock(cap)
    expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()

    cap._AppControl?.biometricAuthenticate?.mockResolvedValueOnce({ authenticated: true })
    const result = await nativeStorage.unlockToken()

    expect(result).toEqual({ ok: true })
    expect(nativeStorage.isTokenLocked()).toBe(false)
    expect(await nativeStorage.get(TOKEN_KEY)).toBe('secret-token')
  })

  it('a failed unlock keeps it locked and surfaces the code', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    const { nativeStorage, TOKEN_KEY } = await armAndLock(cap)

    cap._AppControl?.biometricAuthenticate?.mockResolvedValueOnce({
      authenticated: false,
      code: 'user-canceled',
    })
    const result = await nativeStorage.unlockToken()

    expect(result).toEqual({ ok: false, code: 'user-canceled' })
    expect(nativeStorage.isTokenLocked()).toBe(true)
    expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()
  })

  it('resolves { ok: true } immediately, without prompting, when not locked', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const { nativeStorage } = await loadModule()
    // Never armed => never locked.

    const result = await nativeStorage.unlockToken()

    expect(result).toEqual({ ok: true })
    expect(cap._AppControl?.biometricAuthenticate).not.toHaveBeenCalled()
  })

  it('dedupes concurrent callers onto a single native prompt', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    const { nativeStorage } = await armAndLock(cap)

    let resolveAuth: (v: { authenticated: boolean }) => void = () => {}
    const authPromise = new Promise<{ authenticated: boolean }>((resolve) => {
      resolveAuth = resolve
    })
    cap._AppControl?.biometricAuthenticate?.mockReturnValueOnce(authPromise)

    const p1 = nativeStorage.unlockToken()
    const p2 = nativeStorage.unlockToken()
    resolveAuth({ authenticated: true })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(cap._AppControl?.biometricAuthenticate).toHaveBeenCalledTimes(1)
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
  })
})

describe('biometric lock: setBiometricLockEnabled(false)', () => {
  it('disarms and unlocks immediately, without an app restart', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    const { nativeStorage, TOKEN_KEY } = await armAndLockHelper(cap)
    expect(nativeStorage.isTokenLocked()).toBe(true)

    await nativeStorage.setBiometricLockEnabled(false)

    expect(nativeStorage.isTokenLocked()).toBe(false)
    expect(await nativeStorage.get(TOKEN_KEY)).toBe('secret-token')
    expect(await nativeStorage.isBiometricLockEnabled()).toBe(false)
  })
})

// FLO-159 review fix: setBiometricLockEnabled(true) used to only persist the
// preference, never setting `armed` — so installResumeRelock()'s
// visibilitychange handler (gated on `armed`) stayed dormant for the rest of
// the session and a user who enabled the toggle and backgrounded the app
// wasn't re-locked until the next cold start. Reuses the same fake-document
// visibilitychange harness as the 'resume re-lock' describe block below.
describe('biometric lock: setBiometricLockEnabled(true) arms the resume re-lock', () => {
  function makeFakeDocument(initial: 'visible' | 'hidden' = 'visible') {
    let visibilityState: 'visible' | 'hidden' = initial
    const listeners: Array<() => void> = []
    return {
      addEventListener(type: string, cb: () => void) {
        if (type === 'visibilitychange') listeners.push(cb)
      },
      removeEventListener() {},
      get visibilityState() {
        return visibilityState
      },
      _setVisibility(v: 'visible' | 'hidden') {
        visibilityState = v
        for (const cb of listeners) cb()
      },
    }
  }

  it('does not lock immediately, but re-locks past RELOCK_GRACE_MS on the next hidden→visible cycle', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const fakeDoc = makeFakeDocument()
    ;(globalThis as unknown as { document: unknown }).document = fakeDoc

    try {
      const { nativeStorage, TOKEN_KEY, RELOCK_GRACE_MS } = await loadModule()
      await nativeStorage.set(TOKEN_KEY, 'secret-token')

      await nativeStorage.setBiometricLockEnabled(true)
      // Enabling must never itself lock — the user just passed a live
      // biometric prompt in SettingsSecurity.svelte to get here; locking
      // them out immediately after opting in would be wrong.
      expect(nativeStorage.isTokenLocked()).toBe(false)

      const dateSpy = vi.spyOn(Date, 'now')
      try {
        dateSpy.mockReturnValueOnce(0)
        fakeDoc._setVisibility('hidden')
        dateSpy.mockReturnValueOnce(RELOCK_GRACE_MS)
        fakeDoc._setVisibility('visible')

        expect(nativeStorage.isTokenLocked()).toBe(true)
        expect(await nativeStorage.get(TOKEN_KEY)).toBeNull()
      } finally {
        dateSpy.mockRestore()
      }
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document
    }
  })

  it('does not arm outside the native shell — preference persists, no re-lock on backgrounding', async () => {
    stubBrowserGlobals(undefined)
    const fakeDoc = makeFakeDocument()
    ;(globalThis as unknown as { document: unknown }).document = fakeDoc

    try {
      const { nativeStorage, RELOCK_GRACE_MS } = await loadModule()

      await nativeStorage.setBiometricLockEnabled(true)
      expect(await nativeStorage.isBiometricLockEnabled()).toBe(true)
      expect(nativeStorage.isTokenLocked()).toBe(false)

      const dateSpy = vi.spyOn(Date, 'now')
      try {
        dateSpy.mockReturnValueOnce(0)
        fakeDoc._setVisibility('hidden')
        dateSpy.mockReturnValueOnce(RELOCK_GRACE_MS)
        fakeDoc._setVisibility('visible')
        expect(nativeStorage.isTokenLocked()).toBe(false)
      } finally {
        dateSpy.mockRestore()
      }
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document
    }
  })

  it('does not arm when the plugin predates the biometric methods (older APK) — preference persists, no re-lock', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: false,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const fakeDoc = makeFakeDocument()
    ;(globalThis as unknown as { document: unknown }).document = fakeDoc

    try {
      const { nativeStorage, RELOCK_GRACE_MS } = await loadModule()

      await nativeStorage.setBiometricLockEnabled(true)
      expect(await nativeStorage.isBiometricLockEnabled()).toBe(true)
      expect(nativeStorage.isTokenLocked()).toBe(false)

      const dateSpy = vi.spyOn(Date, 'now')
      try {
        dateSpy.mockReturnValueOnce(0)
        fakeDoc._setVisibility('hidden')
        dateSpy.mockReturnValueOnce(RELOCK_GRACE_MS)
        fakeDoc._setVisibility('visible')
        expect(nativeStorage.isTokenLocked()).toBe(false)
      } finally {
        dateSpy.mockRestore()
      }
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document
    }
  })
})

async function armAndLockHelper(cap: ReturnType<typeof makeFakeCapacitor>) {
  stubBrowserGlobals(cap)
  const mod = await loadModule()
  await mod.nativeStorage.set(mod.TOKEN_KEY, 'secret-token')
  await mod.nativeStorage.setBiometricLockEnabled(true)
  await mod.nativeStorage.initBiometricLock()
  return mod
}

describe('biometric lock: lockToken() event dispatch', () => {
  it('dispatches slipstream:biometric-locked only on a real unlocked→locked transition', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window
    const dispatched: string[] = []
    win.dispatchEvent = vi.fn((event: { type: string }) => {
      dispatched.push(event.type)
      return true
    })
    const hadCustomEvent = 'CustomEvent' in globalThis
    if (!hadCustomEvent) {
      ;(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
        type: string
        constructor(type: string) {
          this.type = type
        }
      }
    }

    try {
      const { nativeStorage, TOKEN_KEY } = await loadModule()
      await nativeStorage.set(TOKEN_KEY, 'secret-token')
      await nativeStorage.setBiometricLockEnabled(true)

      // false -> true: real transition, dispatches.
      await nativeStorage.initBiometricLock()
      expect(dispatched).toEqual(['slipstream:biometric-locked'])

      // Already locked: calling again must not re-dispatch.
      nativeStorage.lockToken()
      expect(dispatched).toEqual(['slipstream:biometric-locked'])

      cap._AppControl?.biometricAuthenticate?.mockResolvedValueOnce({ authenticated: true })
      await nativeStorage.unlockToken()

      // false -> true again: another real transition, dispatches a 2nd time.
      nativeStorage.lockToken()
      expect(dispatched).toEqual(['slipstream:biometric-locked', 'slipstream:biometric-locked'])
    } finally {
      if (!hadCustomEvent) delete (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent
    }
  })
})

describe('biometric lock: resume re-lock (visibilitychange)', () => {
  function makeFakeDocument(initial: 'visible' | 'hidden' = 'visible') {
    let visibilityState: 'visible' | 'hidden' = initial
    const listeners: Array<() => void> = []
    return {
      addEventListener(type: string, cb: () => void) {
        if (type === 'visibilitychange') listeners.push(cb)
      },
      removeEventListener() {},
      get visibilityState() {
        return visibilityState
      },
      _setVisibility(v: 'visible' | 'hidden') {
        visibilityState = v
        for (const cb of listeners) cb()
      },
    }
  }

  it('re-locks past RELOCK_GRACE_MS of hidden time, but not before', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      withPreferences: true,
    })
    stubBrowserGlobals(cap)
    const fakeDoc = makeFakeDocument()
    ;(globalThis as unknown as { document: unknown }).document = fakeDoc

    try {
      const { nativeStorage, TOKEN_KEY, RELOCK_GRACE_MS } = await loadModule()
      await nativeStorage.set(TOKEN_KEY, 'secret-token')
      await nativeStorage.setBiometricLockEnabled(true)
      await nativeStorage.initBiometricLock() // armed, locked=true
      cap._AppControl?.biometricAuthenticate?.mockResolvedValueOnce({ authenticated: true })
      await nativeStorage.unlockToken() // locked=false, armed stays true

      const dateSpy = vi.spyOn(Date, 'now')
      try {
        // Hidden at t=0, resumed just under the grace window: must NOT re-lock.
        dateSpy.mockReturnValueOnce(0)
        fakeDoc._setVisibility('hidden')
        dateSpy.mockReturnValueOnce(RELOCK_GRACE_MS - 1)
        fakeDoc._setVisibility('visible')
        expect(nativeStorage.isTokenLocked()).toBe(false)

        // Hidden again, resumed at exactly the grace window: must re-lock.
        dateSpy.mockReturnValueOnce(100_000)
        fakeDoc._setVisibility('hidden')
        dateSpy.mockReturnValueOnce(100_000 + RELOCK_GRACE_MS)
        fakeDoc._setVisibility('visible')
        expect(nativeStorage.isTokenLocked()).toBe(true)
      } finally {
        dateSpy.mockRestore()
      }
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document
    }
  })
})
