/**
 * Unit tests for the biometric.ts low-level bridge (FLO-159). Mirrors the
 * globalThis.window stubbing pattern in nativeStorage.test.ts. Covers:
 *  - unavailable outside the native shell (no window.Capacitor)
 *  - unavailable on an older APK where AppControl exists but predates the
 *    two biometric methods
 *  - checkBiometricAvailability()/promptBiometric() pass through the native
 *    result when present
 *  - a native call that throws resolves to the safe failure shape rather
 *    than rejecting
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

interface FakeAppControlOptions {
  withAppControl?: boolean
  withBiometric?: boolean
  availabilityImpl?: () => Promise<{ available: boolean; status: string }>
  authenticateImpl?: () => Promise<{ authenticated: boolean; error?: string; code?: string }>
}

function makeFakeCapacitor(opts: FakeAppControlOptions = {}) {
  const AppControl = opts.withAppControl
    ? {
        ...(opts.withBiometric
          ? {
              biometricAvailability: vi.fn(
                opts.availabilityImpl ?? (async () => ({ available: true, status: 'available' })),
              ),
              biometricAuthenticate: vi.fn(
                opts.authenticateImpl ?? (async () => ({ authenticated: true })),
              ),
            }
          : {}),
      }
    : undefined

  return {
    Plugins: { AppControl },
    _AppControl: AppControl,
  }
}

function stubBrowserGlobals(capacitor?: ReturnType<typeof makeFakeCapacitor>) {
  ;(globalThis as { window?: unknown }).window = { Capacitor: capacitor } as unknown
}

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  delete (globalThis as { window?: unknown }).window
})

async function loadModule() {
  return import('./biometric.js')
}

// ── biometricPluginAvailable / outside the native shell ─────────────────────

describe('biometric bridge: unavailable outside the native shell', () => {
  it('biometricPluginAvailable() is false with no window.Capacitor', async () => {
    stubBrowserGlobals(undefined)
    const { biometricPluginAvailable } = await loadModule()
    expect(biometricPluginAvailable()).toBe(false)
  })

  it('checkBiometricAvailability() resolves the safe "unsupported" shape', async () => {
    stubBrowserGlobals(undefined)
    const { checkBiometricAvailability } = await loadModule()
    await expect(checkBiometricAvailability()).resolves.toEqual({
      available: false,
      status: 'unsupported',
    })
  })

  it('promptBiometric() resolves the safe failure shape', async () => {
    stubBrowserGlobals(undefined)
    const { promptBiometric } = await loadModule()
    await expect(promptBiometric()).resolves.toEqual({
      authenticated: false,
      code: 'unsupported',
    })
  })
})

// ── older APK: AppControl present, biometric methods absent ────────────────

describe('biometric bridge: older APK (AppControl present, methods absent)', () => {
  it('biometricPluginAvailable() is false', async () => {
    stubBrowserGlobals(makeFakeCapacitor({ withAppControl: true, withBiometric: false }))
    const { biometricPluginAvailable } = await loadModule()
    expect(biometricPluginAvailable()).toBe(false)
  })

  it('checkBiometricAvailability() resolves the safe "unsupported" shape', async () => {
    stubBrowserGlobals(makeFakeCapacitor({ withAppControl: true, withBiometric: false }))
    const { checkBiometricAvailability } = await loadModule()
    await expect(checkBiometricAvailability()).resolves.toEqual({
      available: false,
      status: 'unsupported',
    })
  })

  it('promptBiometric() resolves the safe failure shape', async () => {
    stubBrowserGlobals(makeFakeCapacitor({ withAppControl: true, withBiometric: false }))
    const { promptBiometric } = await loadModule()
    await expect(promptBiometric()).resolves.toEqual({
      authenticated: false,
      code: 'unsupported',
    })
  })
})

// ── pass-through of the native result ───────────────────────────────────────

describe('biometric bridge: native result pass-through', () => {
  it('biometricPluginAvailable() is true when the methods are present', async () => {
    stubBrowserGlobals(makeFakeCapacitor({ withAppControl: true, withBiometric: true }))
    const { biometricPluginAvailable } = await loadModule()
    expect(biometricPluginAvailable()).toBe(true)
  })

  it('checkBiometricAvailability() returns the native availability result', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      availabilityImpl: async () => ({ available: false, status: 'none-enrolled' }),
    })
    stubBrowserGlobals(cap)
    const { checkBiometricAvailability } = await loadModule()
    await expect(checkBiometricAvailability()).resolves.toEqual({
      available: false,
      status: 'none-enrolled',
    })
  })

  it('promptBiometric() returns the native authentication result on success', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      authenticateImpl: async () => ({ authenticated: true }),
    })
    stubBrowserGlobals(cap)
    const { promptBiometric } = await loadModule()
    await expect(promptBiometric({ title: 'Unlock', subtitle: 'Confirm' })).resolves.toEqual({
      authenticated: true,
      error: undefined,
      code: undefined,
    })
    expect(cap._AppControl?.biometricAuthenticate).toHaveBeenCalledWith({
      title: 'Unlock',
      subtitle: 'Confirm',
    })
  })

  it('promptBiometric() returns the native failure result (e.g. user-canceled)', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      authenticateImpl: async () => ({ authenticated: false, code: 'user-canceled' }),
    })
    stubBrowserGlobals(cap)
    const { promptBiometric } = await loadModule()
    await expect(promptBiometric()).resolves.toEqual({
      authenticated: false,
      code: 'user-canceled',
      error: undefined,
    })
  })
})

// ── a throwing native call resolves to the safe failure shape ──────────────

describe('biometric bridge: native call throws', () => {
  it('checkBiometricAvailability() resolves { available:false, status:"unsupported" } instead of rejecting', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      availabilityImpl: async () => {
        throw new Error('native boom')
      },
    })
    stubBrowserGlobals(cap)
    const { checkBiometricAvailability } = await loadModule()
    await expect(checkBiometricAvailability()).resolves.toEqual({
      available: false,
      status: 'unsupported',
    })
  })

  it('promptBiometric() resolves { authenticated:false, code:"error", error:<message> } instead of rejecting', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      authenticateImpl: async () => {
        throw new Error('native boom')
      },
    })
    stubBrowserGlobals(cap)
    const { promptBiometric } = await loadModule()
    await expect(promptBiometric()).resolves.toEqual({
      authenticated: false,
      code: 'error',
      error: 'native boom',
    })
  })

  it('promptBiometric() stringifies a non-Error throw', async () => {
    const cap = makeFakeCapacitor({
      withAppControl: true,
      withBiometric: true,
      authenticateImpl: async () => {
        throw 'plain string boom'
      },
    })
    stubBrowserGlobals(cap)
    const { promptBiometric } = await loadModule()
    await expect(promptBiometric()).resolves.toEqual({
      authenticated: false,
      code: 'error',
      error: 'plain string boom',
    })
  })
})
