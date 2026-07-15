/**
 * Unit tests for the native push bridge (TASK-I9S44) in push.ts. The mobile
 * app is a Capacitor shell whose WebView loads this SAME SPA — a plain
 * browser or the Electron renderer never sets window.Capacitor, so
 * nativePushAvailable()/enableNativePush()/disableNativePush() must
 * feature-detect it at runtime rather than importing @capacitor/*.
 *
 * The test env is plain Node (vitest.config.ts: environment 'node'), so
 * window/localStorage don't exist unless stubbed — mirrors the
 * globalThis.window/document stubbing pattern in wsApi.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ipcMocks = vi.hoisted(() => ({
  getVapidPublicKey: vi.fn(),
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  getPushPrefs: vi.fn(),
  saveFcmToken: vi.fn().mockResolvedValue(undefined),
  deleteFcmToken: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./ipc', () => ipcMocks)

const toastMocks = vi.hoisted(() => ({ pushToast: vi.fn() }))
vi.mock('./toast', () => toastMocks)

import {
  nativePushAvailable,
  nativePushEnabled,
  enableNativePush,
  disableNativePush,
} from './push.js'

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

type RegistrationArg = { value: string } | { error: string }
type Listener = (arg: RegistrationArg) => void

function makeFakeCapacitor(opts: { pluginAvailable?: boolean; platform?: string } = {}) {
  const listeners: Record<string, Listener[]> = {}
  const plugin = {
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn(async (event: string, cb: Listener) => {
      ;(listeners[event] ??= []).push(cb)
      return { remove: vi.fn() }
    }),
  }
  return {
    isPluginAvailable: vi.fn((name: string) =>
      opts.pluginAvailable === false ? false : name === 'PushNotifications',
    ),
    getPlatform: vi.fn(() => opts.platform ?? 'android'),
    Plugins: { PushNotifications: plugin },
    _plugin: plugin,
    _fire: (event: string, arg: RegistrationArg) => {
      for (const l of listeners[event] ?? []) l(arg)
    },
  }
}

function stubBrowserGlobals(capacitor?: ReturnType<typeof makeFakeCapacitor>) {
  const win = { Capacitor: capacitor } as unknown
  ;(globalThis as { window?: unknown }).window = win
  ;(globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage()
}

afterEach(() => {
  vi.clearAllMocks()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('nativePushAvailable', () => {
  it('is false when window is not the Capacitor shell (plain browser/Electron)', () => {
    stubBrowserGlobals(undefined)
    expect(nativePushAvailable()).toBe(false)
  })

  it('is false when window.Capacitor exists but PushNotifications is unavailable', () => {
    stubBrowserGlobals(makeFakeCapacitor({ pluginAvailable: false }))
    expect(nativePushAvailable()).toBe(false)
  })

  it('is true when the Capacitor bridge reports PushNotifications available', () => {
    stubBrowserGlobals(makeFakeCapacitor())
    expect(nativePushAvailable()).toBe(true)
  })
})

describe('nativePushEnabled', () => {
  it('is false with no stored token', async () => {
    stubBrowserGlobals(makeFakeCapacitor())
    expect(await nativePushEnabled()).toBe(false)
  })

  it('is true once a token has been stored (via the legacy-key migration)', async () => {
    stubBrowserGlobals(makeFakeCapacitor())
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'slipstream.fcmToken',
      'dev-1',
    )
    expect(await nativePushEnabled()).toBe(true)
  })
})

describe('enableNativePush', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns unsupported when the Capacitor bridge is absent', async () => {
    stubBrowserGlobals(undefined)
    const result = await enableNativePush()
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('returns denied when permission is not granted', async () => {
    const cap = makeFakeCapacitor()
    cap._plugin.requestPermissions.mockResolvedValueOnce({ receive: 'denied' })
    stubBrowserGlobals(cap)
    const result = await enableNativePush()
    expect(result).toEqual({ ok: false, reason: 'denied' })
    expect(cap._plugin.register).not.toHaveBeenCalled()
  })

  it('registers and saves the device token once the registration event fires', async () => {
    const cap = makeFakeCapacitor({ platform: 'android' })
    stubBrowserGlobals(cap)

    const result = await enableNativePush()
    expect(result).toEqual({ ok: true })
    expect(cap._plugin.register).toHaveBeenCalledOnce()

    cap._fire('registration', { value: 'device-token-abc' })
    // saveFcmToken and the native-storage write are both fire-and-forget
    // inside the listener.
    await new Promise((r) => setTimeout(r, 0))

    expect(ipcMocks.saveFcmToken).toHaveBeenCalledWith({
      token: 'device-token-abc',
      platform: 'android',
    })
    expect(await nativePushEnabled()).toBe(true)
  })

  it('tags the token with platform ios when Capacitor reports ios', async () => {
    const cap = makeFakeCapacitor({ platform: 'ios' })
    stubBrowserGlobals(cap)
    await enableNativePush()
    cap._fire('registration', { value: 'ios-token' })
    await new Promise((r) => setTimeout(r, 0))
    expect(ipcMocks.saveFcmToken).toHaveBeenCalledWith({ token: 'ios-token', platform: 'ios' })
  })

  it('surfaces a registrationError via the toast path', async () => {
    const cap = makeFakeCapacitor()
    stubBrowserGlobals(cap)
    await enableNativePush()
    cap._fire('registrationError', { error: 'boom' })
    expect(toastMocks.pushToast).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
  })
})

describe('disableNativePush', () => {
  it('deletes the stored token and clears local storage', async () => {
    const cap = makeFakeCapacitor()
    stubBrowserGlobals(cap)
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'slipstream.fcmToken',
      'dev-to-remove',
    )

    await disableNativePush()

    expect(ipcMocks.deleteFcmToken).toHaveBeenCalledWith('dev-to-remove')
    expect(await nativePushEnabled()).toBe(false)
    // The legacy key must be cleared too, or the next read would resurrect
    // the disabled token via the migration path.
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
        'slipstream.fcmToken',
      ),
    ).toBeNull()
  })

  it('is a no-op when no token was ever stored', async () => {
    stubBrowserGlobals(makeFakeCapacitor())
    await disableNativePush()
    expect(ipcMocks.deleteFcmToken).not.toHaveBeenCalled()
  })
})
