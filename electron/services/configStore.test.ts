import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { createConfigStore, type SecretEncryptor } from './configStore.js'

const ENC_PREFIX = 'ss1:'

/** Minimal fake for the config table — the real better-sqlite3 is built for
 *  Electron's ABI and can't load under Node vitest (see docs/NATIVE-MODULES.md),
 *  so, like migrations.test.ts, we fake the two statements configStore prepares. */
function makeDb() {
  const data = new Map<string, string>()
  const db = {
    prepare(sql: string) {
      if (/^SELECT value FROM config/.test(sql)) {
        return {
          get: (key: string) => (data.has(key) ? { value: data.get(key)! } : undefined),
        }
      }
      if (/^INSERT INTO config/.test(sql)) {
        return {
          run: (key: string, value: string) => {
            data.set(key, value)
          },
        }
      }
      throw new Error(`unexpected SQL in fake db: ${sql}`)
    },
  }
  return { db: db as unknown as Database.Database, data }
}

/** Reversible fake: base64 with the ss1: marker, mirroring safeStorage's shape. */
function makeEncryptor(): SecretEncryptor {
  return {
    encrypt: (plain) => ENC_PREFIX + Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (stored) => Buffer.from(stored.slice(ENC_PREFIX.length), 'base64').toString('utf8'),
  }
}

describe('createConfigStore', () => {
  it('round-trips a non-secret value in plaintext', () => {
    const { db, data } = makeDb()
    const store = createConfigStore(db, { encryptor: makeEncryptor() })
    store.set('theme', 'dark')
    expect(store.get('theme')).toBe('dark')
    expect(data.get('theme')).toBe('dark')
  })

  it('encrypts secret keys at rest and decrypts on read', () => {
    const { db, data } = makeDb()
    const store = createConfigStore(db, { encryptor: makeEncryptor() })
    store.set('linear.apiKey', 'lin_api_secret')
    const raw = data.get('linear.apiKey')!
    expect(raw.startsWith(ENC_PREFIX)).toBe(true)
    expect(raw).not.toContain('lin_api_secret')
    expect(store.get('linear.apiKey')).toBe('lin_api_secret')
  })

  it('returns undefined for a missing key', () => {
    const store = createConfigStore(makeDb().db, { encryptor: makeEncryptor() })
    expect(store.get('nope')).toBeUndefined()
  })

  it('returns undefined when decryption throws', () => {
    const { db } = makeDb()
    const broken: SecretEncryptor = {
      encrypt: makeEncryptor().encrypt,
      decrypt: () => {
        throw new Error('keychain unavailable')
      },
    }
    const store = createConfigStore(db, { encryptor: broken })
    store.set('github.token', 'ghp_secret')
    expect(store.get('github.token')).toBeUndefined()
  })

  it('returns undefined (not ciphertext) for an encrypted value when no encryptor is present', () => {
    const { db } = makeDb()
    // Desktop app (with encryptor) writes the secret…
    createConfigStore(db, { encryptor: makeEncryptor() }).set('linear.apiKey', 'lin_api_secret')
    // …then the headless daemon (no encryptor) reads the same DB. It must see
    // the secret as absent, never the literal ss1:<base64> ciphertext.
    const headless = createConfigStore(db)
    expect(headless.get('linear.apiKey')).toBeUndefined()
  })

  it('still returns legacy plaintext secrets when no encryptor is present', () => {
    const { db } = makeDb()
    const headless = createConfigStore(db)
    headless.set('linear.apiKey', 'legacy_plain')
    expect(headless.get('linear.apiKey')).toBe('legacy_plain')
  })
})
