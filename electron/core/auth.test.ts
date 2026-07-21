import { describe, it, expect } from 'vitest'
import { resolveIdentity, LOCAL_IDENTITY } from './auth.js'

describe('resolveIdentity', () => {
  it('maps the static SLIPSTREAM_TOKEN to the local owner', () => {
    expect(resolveIdentity('secret', { staticToken: 'secret' })).toEqual(LOCAL_IDENTITY)
  })

  it('does not match a wrong token against the static token', () => {
    expect(resolveIdentity('wrong', { staticToken: 'secret' })).toBeUndefined()
  })

  it('falls back to the device token store for a non-static token', () => {
    const identity = resolveIdentity('device-token', {
      staticToken: 'secret',
      deviceTokens: { resolveToken: (t) => (t === 'device-token' ? { id: 'alice' } : undefined) },
    })
    expect(identity).toEqual({ id: 'alice' })
  })

  it('returns undefined when the token matches neither the static token nor the device store', () => {
    const identity = resolveIdentity('unknown-token', {
      staticToken: 'secret',
      deviceTokens: { resolveToken: () => undefined },
    })
    expect(identity).toBeUndefined()
  })

  it('returns undefined for a non-static token when no device token store is configured', () => {
    expect(resolveIdentity('device-token', { staticToken: 'secret' })).toBeUndefined()
  })
})
