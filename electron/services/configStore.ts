import Database from 'better-sqlite3'
import { createRequire } from 'node:module'

export interface IConfigStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** Config keys whose values are secrets and get encrypted at rest when an
 *  encryptor is available (desktop safeStorage). Everything else stays plaintext. */
export const SECRET_KEYS = new Set(['linear.apiKey', 'github.token', 'gitlab.token'])

/** Marker prefix identifying a safeStorage-encrypted, base64-encoded value, so
 *  reads can transparently decrypt new values while still returning legacy
 *  plaintext ones. */
const ENC_PREFIX = 'ss1:'

/** Minimal encryptor seam. Backed by Electron safeStorage on desktop; omitted
 *  (plaintext) on the headless server / ELECTRON_RUN_AS_NODE daemon, where no
 *  OS keychain is reachable. */
export interface SecretEncryptor {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

export interface ConfigStoreOptions {
  encryptor?: SecretEncryptor
  secretKeys?: Set<string>
}

export function createConfigStore(
  db: Database.Database,
  opts: ConfigStoreOptions = {},
): IConfigStore {
  const { encryptor, secretKeys = SECRET_KEYS } = opts
  const getStmt = db.prepare<[string], { value: string }>('SELECT value FROM config WHERE key = ?')
  const setStmt = db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  return {
    get(key: string): string | undefined {
      const raw = getStmt.get(key)?.value
      if (raw === undefined) return undefined
      if (encryptor && raw.startsWith(ENC_PREFIX)) {
        try {
          return encryptor.decrypt(raw)
        } catch {
          return undefined
        }
      }
      return raw // legacy plaintext or non-secret value
    },
    set(key: string, value: string): void {
      const stored = encryptor && secretKeys.has(key) ? encryptor.encrypt(value) : value
      setStmt.run(key, stored)
    },
  }
}

/** Build a safeStorage-backed encryptor when running inside a real Electron
 *  process with an available OS keychain. Returns undefined on the headless
 *  server / ELECTRON_RUN_AS_NODE daemon (where `require('electron')` yields the
 *  binary path string, not the API) and under plain Node — callers then fall
 *  back to plaintext storage. */
export function createSafeStorageEncryptor(): SecretEncryptor | undefined {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as
      | {
          safeStorage?: {
            isEncryptionAvailable(): boolean
            encryptString(s: string): Buffer
            decryptString(b: Buffer): string
          }
        }
      | string
    const safeStorage = typeof electron === 'object' ? electron.safeStorage : undefined
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return undefined
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return {
      encrypt: (plain) => ENC_PREFIX + safeStorage.encryptString(plain).toString('base64'),
      decrypt: (stored) =>
        safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')),
    }
  } catch {
    return undefined
  }
}
