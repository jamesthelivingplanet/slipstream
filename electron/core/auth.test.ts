import { describe, it, expect } from 'vitest'
import { resolveIdentity, LOCAL_IDENTITY } from './auth.js'

describe('resolveIdentity', () => {
  it('maps any valid token to the local owner today', () => {
    expect(resolveIdentity('any-token')).toEqual({ id: 'local' })
    expect(resolveIdentity('another')).toEqual(LOCAL_IDENTITY)
  })
})
