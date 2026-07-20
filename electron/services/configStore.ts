import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  type CipherGCMTypes,
} from 'node:crypto'

export interface IConfigStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** Config keys whose values are secrets and get encrypted at rest when an
 *  encryptor is available. Everything else stays plaintext. */
export const SECRET_KEYS = new Set([
  'linear.apiKey',
  'github.token',
  'gitlab.token',
  'bitbucket.token',
  'gitea.token',
  'jira.apiToken',
  // TASK-I9S44: raw Firebase service-account JSON (RSA private key inside) —
  // see pushService.ts's FCM_SERVICE_ACCOUNT_CONFIG_KEY.
  'push.fcmServiceAccount',
])

/** Marker prefix for a safeStorage-encrypted, base64-encoded value (desktop OS
 *  keychain). */
const SS_PREFIX = 'ss1:'

/** Marker prefix for a server-key AES-256-GCM value (FLO-145) — used on the
 *  daemon / headless server where no OS keychain is reachable. */
const SERVER_PREFIX = 'sk1:'

/** All known at-rest encryption markers. A value carrying any of these is
 *  ciphertext, never plaintext, and must never be returned to a caller raw:
 *  if the active encryptor can't handle the marker, the value reads as absent. */
const ENC_PREFIXES = [SS_PREFIX, SERVER_PREFIX]

/** Minimal encryptor seam. Each implementation owns exactly one `prefix`; a
 *  stored value is decryptable only by the encryptor whose prefix it carries. */
export interface SecretEncryptor {
  prefix: string
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

  // FLO-145: opportunistically re-encrypt any legacy plaintext secrets so they
  // stop sitting in the DB as cleartext. Safe and non-locking: we hold the key,
  // so the value stays readable; already-encrypted values (any marker) are left
  // untouched, and any failure leaves the plaintext in place rather than
  // aborting startup. This is a rewrite-in-place, not a force-migration.
  if (encryptor) {
    try {
      for (const key of secretKeys) {
        const raw = getStmt.get(key)?.value
        if (raw === undefined) continue
        if (ENC_PREFIXES.some((p) => raw.startsWith(p))) continue
        try {
          setStmt.run(key, encryptor.encrypt(raw))
        } catch {
          // leave this value plaintext; never block boot on a single key
        }
      }
    } catch {
      // best-effort migration only
    }
  }

  return {
    get(key: string): string | undefined {
      const raw = getStmt.get(key)?.value
      if (raw === undefined) return undefined
      const marker = ENC_PREFIXES.find((p) => raw.startsWith(p))
      if (marker) {
        // Encrypted at rest. Only the encryptor whose prefix matches can read
        // it; anything else (no encryptor, or a different scheme) treats the
        // value as absent rather than leaking ciphertext to callers.
        if (!encryptor || encryptor.prefix !== marker) return undefined
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
 *  back to the server-key encryptor or plaintext storage. */
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
      prefix: SS_PREFIX,
      encrypt: (plain) => SS_PREFIX + safeStorage.encryptString(plain).toString('base64'),
      decrypt: (stored) =>
        safeStorage.decryptString(Buffer.from(stored.slice(SS_PREFIX.length), 'base64')),
    }
  } catch {
    return undefined
  }
}

const GCM_ALGO: CipherGCMTypes = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/** Pure AES-256-GCM encryptor over a caller-supplied 32-byte key. Stored form:
 *  `sk1:` + base64(iv[12] || authTag[16] || ciphertext). Exported for tests. */
export function createAesGcmEncryptor(key: Buffer): SecretEncryptor {
  if (key.length !== KEY_LEN) throw new Error(`server key must be ${KEY_LEN} bytes`)
  return {
    prefix: SERVER_PREFIX,
    encrypt(plain) {
      const iv = randomBytes(IV_LEN)
      const cipher = createCipheriv(GCM_ALGO, key, iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return SERVER_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
    },
    decrypt(stored) {
      const buf = Buffer.from(stored.slice(SERVER_PREFIX.length), 'base64')
      const iv = buf.subarray(0, IV_LEN)
      const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
      const ct = buf.subarray(IV_LEN + TAG_LEN)
      const decipher = createDecipheriv(GCM_ALGO, key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
  }
}

/**
 * Resolve the 32-byte key backing the server encryptor.
 *
 * - If `SLIPSTREAM_SECRET` is set (an operator-supplied passphrase), derive the
 *   key via scrypt with a per-install random salt persisted at
 *   `<dataDir>/secret.salt`. The key itself never touches disk — theft of
 *   `slipstream.db` (or the whole data dir) without the passphrase yields only
 *   ciphertext.
 * - Otherwise fall back to a random 32-byte key persisted at
 *   `<dataDir>/secret.key` (0600). Zero-config; protects against theft of
 *   `slipstream.db` alone (a DB backup / single-file leak), but NOT against a
 *   reader of the whole data dir, who gets the key file too.
 *
 * Both salt/key files are created 0600 inside the already-0700 data dir.
 */
function resolveServerKey(dataDir: string, env: NodeJS.ProcessEnv): Buffer {
  const passphrase = env.SLIPSTREAM_SECRET?.trim()
  if (passphrase) {
    const saltPath = path.join(dataDir, 'secret.salt')
    let salt: Buffer
    if (fs.existsSync(saltPath)) {
      salt = fs.readFileSync(saltPath)
    } else {
      salt = randomBytes(16)
      fs.writeFileSync(saltPath, salt, { mode: 0o600 })
    }
    return scryptSync(passphrase, salt, KEY_LEN)
  }

  const keyPath = path.join(dataDir, 'secret.key')
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64')
    if (key.length === KEY_LEN) return key
    // corrupt/short key file — fall through and regenerate
  }
  const key = randomBytes(KEY_LEN)
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 })
  return key
}

/** Build the non-keychain encryptor for the daemon / headless server (FLO-145).
 *  Key comes from `SLIPSTREAM_SECRET` (passphrase) or a file-backed key under the
 *  0700 data dir. Returns undefined only if the key can't be resolved (e.g. the
 *  data dir isn't writable), in which case callers fall back to plaintext. */
export function createServerEncryptor(opts: {
  dataDir: string
  env?: NodeJS.ProcessEnv
}): SecretEncryptor | undefined {
  try {
    const key = resolveServerKey(opts.dataDir, opts.env ?? process.env)
    return createAesGcmEncryptor(key)
  } catch {
    return undefined
  }
}
