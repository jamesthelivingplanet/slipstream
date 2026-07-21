import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { createDeviceTokenStore } from './deviceTokenStore.js'
import type { DeviceTokenRow } from '../db/db.js'

/** Minimal fake for the device_tokens table — the real better-sqlite3 is built
 *  for Electron's ABI and can't load under Node vitest (see
 *  docs/NATIVE-MODULES.md), so, like configStore.test.ts, we fake the
 *  statements db.ts prepares. */
function makeDb() {
  const rows = new Map<string, DeviceTokenRow>()
  const db = {
    prepare(sql: string) {
      if (/^\s*INSERT INTO device_tokens/.test(sql)) {
        return {
          run: (row: DeviceTokenRow) => {
            rows.set(row.id, { ...row })
          },
        }
      }
      if (/WHERE tokenHash = \?/.test(sql)) {
        return {
          get: (tokenHash: string) =>
            Array.from(rows.values()).find((r) => r.tokenHash === tokenHash),
        }
      }
      if (/WHERE id = \?/.test(sql) && /^SELECT/.test(sql)) {
        return {
          get: (id: string) => rows.get(id),
        }
      }
      if (/^SELECT \* FROM device_tokens ORDER BY createdAt/.test(sql)) {
        return {
          all: () => Array.from(rows.values()).sort((a, b) => a.createdAt - b.createdAt),
        }
      }
      if (/^UPDATE device_tokens SET revokedAt/.test(sql)) {
        return {
          run: (revokedAt: number, id: string) => {
            const row = rows.get(id)
            if (row && row.revokedAt === null) row.revokedAt = revokedAt
          },
        }
      }
      throw new Error(`unexpected SQL in fake db: ${sql}`)
    },
  }
  return { db: db as unknown as Database.Database, rows }
}

describe('createDeviceTokenStore', () => {
  it('issues a token that resolves to the owning identity', () => {
    const { db } = makeDb()
    const store = createDeviceTokenStore(db)

    const { token, dto } = store.issue('alice', 'alice-phone')
    expect(dto.ownerId).toBe('alice')
    expect(dto.label).toBe('alice-phone')
    expect(dto.revokedAt).toBeNull()

    expect(store.resolveToken(token)).toEqual({ id: 'alice' })
  })

  it('never persists the plaintext token or exposes it via list/get', () => {
    const { db, rows } = makeDb()
    const store = createDeviceTokenStore(db)

    const { token, dto } = store.issue('alice', 'alice-phone')
    const row = rows.get(dto.id)!
    expect(row.tokenHash).not.toBe(token)
    expect(JSON.stringify(store.list())).not.toContain(token)
    expect(JSON.stringify(store.get(dto.id))).not.toContain(token)
  })

  it('isolates distinct owners: each token resolves only to its own owner', () => {
    const { db } = makeDb()
    const store = createDeviceTokenStore(db)

    const alice = store.issue('alice', 'alice-phone')
    const bob = store.issue('bob', 'bob-laptop')

    expect(store.resolveToken(alice.token)).toEqual({ id: 'alice' })
    expect(store.resolveToken(bob.token)).toEqual({ id: 'bob' })
  })

  it('revoking one device credential does not affect another', () => {
    const { db } = makeDb()
    const store = createDeviceTokenStore(db)

    const alice = store.issue('alice', 'alice-phone')
    const bob = store.issue('bob', 'bob-laptop')

    store.revoke(alice.dto.id)

    expect(store.resolveToken(alice.token)).toBeUndefined()
    expect(store.resolveToken(bob.token)).toEqual({ id: 'bob' })
    expect(store.get(alice.dto.id)?.revokedAt).not.toBeNull()
    expect(store.get(bob.dto.id)?.revokedAt).toBeNull()
  })

  it('revoke is idempotent and a no-op for an unknown id', () => {
    const { db } = makeDb()
    const store = createDeviceTokenStore(db)

    const alice = store.issue('alice', 'alice-phone')
    store.revoke(alice.dto.id)
    const revokedAt = store.get(alice.dto.id)?.revokedAt
    store.revoke(alice.dto.id) // second revoke: must not move revokedAt forward
    expect(store.get(alice.dto.id)?.revokedAt).toBe(revokedAt)

    expect(() => store.revoke('does-not-exist')).not.toThrow()
  })

  it('resolveToken returns undefined for an unknown/garbage token', () => {
    const { db } = makeDb()
    const store = createDeviceTokenStore(db)
    store.issue('alice', 'alice-phone')

    expect(store.resolveToken('not-a-real-token')).toBeUndefined()
  })

  it('list returns every issued token as a DTO', () => {
    const { db } = makeDb()
    const store = createDeviceTokenStore(db)
    store.issue('alice', 'alice-phone')
    store.issue('bob', 'bob-laptop')

    const all = store.list()
    expect(all.map((d) => d.ownerId).sort()).toEqual(['alice', 'bob'])
  })
})
