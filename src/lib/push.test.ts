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

const storesMocks = vi.hoisted(() => ({ openAgentById: vi.fn() }))
vi.mock('./stores', () => storesMocks)

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

type RegistrationArg =
  | { value: string }
  | { error: string }
  | { actionId: string; notification: { data?: Record<string, string> } }
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

// origin is a separate param (not read off window) because in a real
// browser location is its own global, independent of window.Capacitor —
// mirrors nativeAppOrigin()'s `typeof location` guard in push.ts. Omitted by
// default so most tests run exactly as before TASK-F0TYG (no `location`
// global at all in the Node test env, same as pre-existing behavior).
function stubBrowserGlobals(capacitor?: ReturnType<typeof makeFakeCapacitor>, origin?: string) {
  const win = { Capacitor: capacitor } as unknown
  ;(globalThis as { window?: unknown }).window = win
  ;(globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage()
  if (origin !== undefined) {
    ;(globalThis as { location?: unknown }).location = { origin }
  }
}

afterEach(() => {
  vi.clearAllMocks()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
  delete (globalThis as { location?: unknown }).location
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

  describe('origin (TASK-F0TYG follow-up)', () => {
    it('includes location.origin in the saved DTO when it is a real https origin', async () => {
      const cap = makeFakeCapacitor({ platform: 'android' })
      stubBrowserGlobals(cap, 'https://slipstream.example.ts.net')
      await enableNativePush()
      cap._fire('registration', { value: 'device-token-abc' })
      await new Promise((r) => setTimeout(r, 0))

      expect(ipcMocks.saveFcmToken).toHaveBeenCalledWith({
        token: 'device-token-abc',
        platform: 'android',
        origin: 'https://slipstream.example.ts.net',
      })
    })

    it('includes an http origin too — only pushService.ts filters by scheme for the image', async () => {
      const cap = makeFakeCapacitor({ platform: 'android' })
      stubBrowserGlobals(cap, 'http://192.168.1.50:9091')
      await enableNativePush()
      cap._fire('registration', { value: 'device-token-abc' })
      await new Promise((r) => setTimeout(r, 0))

      expect(ipcMocks.saveFcmToken).toHaveBeenCalledWith({
        token: 'device-token-abc',
        platform: 'android',
        origin: 'http://192.168.1.50:9091',
      })
    })

    it('omits origin when location.origin is the literal "null" (opaque/sandboxed context)', async () => {
      const cap = makeFakeCapacitor({ platform: 'android' })
      stubBrowserGlobals(cap, 'null')
      await enableNativePush()
      cap._fire('registration', { value: 'device-token-abc' })
      await new Promise((r) => setTimeout(r, 0))

      const call = ipcMocks.saveFcmToken.mock.calls[0][0] as { origin?: string }
      expect(call.origin).toBeUndefined()
    })

    it('omits origin when there is no location global at all', async () => {
      const cap = makeFakeCapacitor({ platform: 'android' })
      stubBrowserGlobals(cap) // no origin arg — no `location` stubbed, matching plain Node
      await enableNativePush()
      cap._fire('registration', { value: 'device-token-abc' })
      await new Promise((r) => setTimeout(r, 0))

      const call = ipcMocks.saveFcmToken.mock.calls[0][0] as { origin?: string }
      expect(call.origin).toBeUndefined()
    })
  })

  it('surfaces a registrationError via the toast path', async () => {
    const cap = makeFakeCapacitor()
    stubBrowserGlobals(cap)
    await enableNativePush()
    cap._fire('registrationError', { error: 'boom' })
    expect(toastMocks.pushToast).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
  })

  it('registers a pushNotificationActionPerformed listener that opens the tapped agent', async () => {
    const cap = makeFakeCapacitor()
    stubBrowserGlobals(cap)
    await enableNativePush()

    expect(cap._plugin.addListener).toHaveBeenCalledWith(
      'pushNotificationActionPerformed',
      expect.any(Function),
    )

    cap._fire('pushNotificationActionPerformed', {
      actionId: 'tap',
      notification: { data: { sessionId: 's1', tid: 'FLO-1', status: 'needs' } },
    })

    expect(storesMocks.openAgentById).toHaveBeenCalledWith('s1')
  })

  it('does not open an agent when the tapped notification carries no sessionId', async () => {
    const cap = makeFakeCapacitor()
    stubBrowserGlobals(cap)
    await enableNativePush()

    cap._fire('pushNotificationActionPerformed', {
      actionId: 'tap',
      notification: {},
    })

    expect(storesMocks.openAgentById).not.toHaveBeenCalled()
  })

  it('does not double-register the tap listener across repeated enableNativePush calls', async () => {
    const cap = makeFakeCapacitor()
    stubBrowserGlobals(cap)
    await enableNativePush()
    await enableNativePush()

    const tapRegistrations = cap._plugin.addListener.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pushNotificationActionPerformed',
    )
    expect(tapRegistrations).toHaveLength(1)
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
