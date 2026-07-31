import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDevicePairingStore, createPairRateLimiter } from './devicePairing.js'

describe('createDevicePairingStore', () => {
  let stores: { dispose(): void }[] = []
  afterEach(() => {
    for (const s of stores) s.dispose()
    stores = []
    vi.useRealTimers()
  })

  function makeStore(ttlMs?: number) {
    const store = createDevicePairingStore(ttlMs)
    stores.push(store)
    return store
  }

  it('mints a code bound to the CALLER identity, not any client-supplied value', () => {
    const store = makeStore()
    const { code, expiresAt } = store.issue({ id: 'alice' })
    expect(typeof code).toBe('string')
    expect(code.length).toBeGreaterThan(15)
    expect(expiresAt).toBeGreaterThan(Date.now())

    const ownerId = store.redeem(code)
    expect(ownerId).toBe('alice')
  })

  it('is single-use — a second redemption of the same code fails', () => {
    const store = makeStore()
    const { code } = store.issue({ id: 'alice' })

    expect(store.redeem(code)).toBe('alice')
    expect(store.redeem(code)).toBeUndefined()
  })

  it('a concurrent double-redeem only lets ONE caller win', () => {
    const store = makeStore()
    const { code } = store.issue({ id: 'alice' })

    // Both "requests" call redeem() synchronously in the same tick — models
    // two devices racing to POST /pair with the same scanned/typed code.
    const results = [store.redeem(code), store.redeem(code)]
    const successes = results.filter((r) => r !== undefined)
    expect(successes).toEqual(['alice'])
  })

  it('expires after the TTL', async () => {
    const store = makeStore(20)
    const { code } = store.issue({ id: 'alice' })

    await new Promise((r) => setTimeout(r, 50))

    expect(store.redeem(code)).toBeUndefined()
  })

  it('an unknown code returns the same undefined as expired/used', () => {
    const store = makeStore()
    expect(store.redeem('not-a-real-code')).toBeUndefined()
  })

  it('a wrong code, an expired code, an already-used code, and an unknown code are all indistinguishable (uniform undefined)', async () => {
    const store = makeStore(20)
    const { code: usedCode } = store.issue({ id: 'alice' })
    store.redeem(usedCode) // burn it

    const { code: expiringCode } = store.issue({ id: 'bob' })
    await new Promise((r) => setTimeout(r, 50)) // let it expire

    const results = [
      store.redeem('totally-unknown-code'),
      store.redeem(usedCode),
      store.redeem(expiringCode),
    ]
    expect(results).toEqual([undefined, undefined, undefined])
  })

  it('issuing multiple codes for different identities keeps them independent', () => {
    const store = makeStore()
    const { code: aliceCode } = store.issue({ id: 'alice' })
    const { code: bobCode } = store.issue({ id: 'bob' })

    expect(store.redeem(bobCode)).toBe('bob')
    expect(store.redeem(aliceCode)).toBe('alice')
  })
})

describe('createPairRateLimiter', () => {
  let limiters: { dispose(): void }[] = []
  afterEach(() => {
    for (const l of limiters) l.dispose()
    limiters = []
  })

  function makeLimiter(windowMs?: number, max?: number) {
    const limiter = createPairRateLimiter(windowMs, max)
    limiters.push(limiter)
    return limiter
  }

  it('allows up to `max` attempts per key within the window', () => {
    const limiter = makeLimiter(60_000, 3)
    expect(limiter.allow('1.2.3.4')).toBe(true)
    expect(limiter.allow('1.2.3.4')).toBe(true)
    expect(limiter.allow('1.2.3.4')).toBe(true)
    expect(limiter.allow('1.2.3.4')).toBe(false)
  })

  it('tracks distinct keys independently', () => {
    const limiter = makeLimiter(60_000, 1)
    expect(limiter.allow('1.1.1.1')).toBe(true)
    expect(limiter.allow('2.2.2.2')).toBe(true)
    expect(limiter.allow('1.1.1.1')).toBe(false)
    expect(limiter.allow('2.2.2.2')).toBe(false)
  })

  it('resets after the window elapses', async () => {
    const limiter = makeLimiter(20, 1)
    expect(limiter.allow('1.2.3.4')).toBe(true)
    expect(limiter.allow('1.2.3.4')).toBe(false)

    await new Promise((r) => setTimeout(r, 40))

    expect(limiter.allow('1.2.3.4')).toBe(true)
  })
})
