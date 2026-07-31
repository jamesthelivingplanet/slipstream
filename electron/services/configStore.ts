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
  /** Owner-scoped accessors (see isOwnerScopedKey / OWNER_SCOPED_PREFIXES
   *  above). Optional on the interface so every existing fake/mock
   *  IConfigStore elsewhere in the test suite keeps compiling unchanged —
   *  this must be a strictly additive extension, since dozens of files
   *  outside this change's scope construct hand-rolled IConfigStore fakes.
   *  The real store returned by createConfigStore always implements both;
   *  callers that need them assert non-null rather than silently no-op'ing. */
  getForOwner?(ownerId: string, key: string): string | undefined
  setForOwner?(ownerId: string, key: string, value: string): void
}

/** The identity the static SLIPSTREAM_TOKEN always resolves to (see
 *  docs/IDENTITY-SEAM.md) — the single-user/local tier default, and the
 *  owner whose per-owner config rows are mirrored into the legacy
 *  deployment-global `config` table (see setForOwner below). */
export const DEFAULT_OWNER_ID = 'local'

/**
 * FLO-48 item 6: the `config` table is deployment-global — every owner on a
 * deployment shares one set of values. That's fine for settings that
 * describe the daemon's own behavior (GC policy, scheduler policy, spawn
 * policy, budget policy, editor command, agentArgs) but wrong for
 * integration credentials: two owners on the same deployment would
 * reasonably want their own Linear/Jira/git-host tokens, not one shared
 * set. OWNER_SCOPED_PREFIXES draws that line — namespaces whose keys
 * (credentials, plus the non-secret settings that ride along with them,
 * e.g. ticket-source scoping like `linear.teamKeys`/`github.issueRepos`,
 * git host `username`/`baseUrl`) go in the per-owner `config_owner` table
 * instead of the shared `config` table.
 *
 * Classification is by namespace *prefix*, not an enumerated key list,
 * specifically so a new key under an existing integration namespace (e.g. a
 * future `linear.somethingNew`) is automatically classified correctly
 * without anyone having to remember to update a list — a new integration
 * should add its prefix here.
 *
 * Note `push.fcmServiceAccount` is secret (see SECRET_KEYS above) but
 * deliberately deployment-global: it's the daemon's own push credential,
 * not any owner's. Note also that `editor.command`/`editor.mobileCommand`/
 * `agentArgs.<kind>` remain deployment-global for now — out of scope for
 * this pass, even though they're arguably per-owner by the same rationale,
 * because no call site for them was migrated.
 */
export const OWNER_SCOPED_PREFIXES = [
  'linear.',
  'jira.',
  'github.',
  'gitlab.',
  'bitbucket.',
  'gitea.',
]

/** True if `key` falls under one of OWNER_SCOPED_PREFIXES — see the doc
 *  comment on OWNER_SCOPED_PREFIXES above for the rationale. */
export function isOwnerScopedKey(key: string): boolean {
  return OWNER_SCOPED_PREFIXES.some((p) => key.startsWith(p))
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
  const getOwnerStmt = db.prepare<[string, string], { value: string }>(
    'SELECT value FROM config_owner WHERE ownerId = ? AND key = ?',
  )
  const setOwnerStmt = db.prepare(
    `INSERT INTO config_owner (ownerId, key, value) VALUES (?, ?, ?)
   ON CONFLICT(ownerId, key) DO UPDATE SET value = excluded.value`,
  )
  const allOwnerRowsStmt = db.prepare('SELECT ownerId, key, value FROM config_owner')

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

    // Same opportunistic re-encrypt sweep, but over config_owner. ownerIds
    // aren't known ahead of time so we can't loop ownerId×secretKeys like the
    // sweep above — instead do one full-table scan (config_owner is small,
    // not a hot path) and filter in JS.
    try {
      for (const row of allOwnerRowsStmt.all() as {
        ownerId: string
        key: string
        value: string
      }[]) {
        if (!secretKeys.has(row.key)) continue
        if (ENC_PREFIXES.some((p) => row.value.startsWith(p))) continue
        try {
          setOwnerStmt.run(row.ownerId, row.key, encryptor.encrypt(row.value))
        } catch {
          // leave this value plaintext; never block boot on a single key
        }
      }
    } catch {
      // best-effort migration only
    }
  }

  /** Shared marker/decrypt logic for both get() and getForOwner(). */
  function decryptRaw(raw: string): string | undefined {
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
  }

  return {
    get(key: string): string | undefined {
      const raw = getStmt.get(key)?.value
      if (raw === undefined) return undefined
      return decryptRaw(raw)
    },
    set(key: string, value: string): void {
      const stored = encryptor && secretKeys.has(key) ? encryptor.encrypt(value) : value
      setStmt.run(key, stored)
    },

    getForOwner(ownerId: string, key: string): string | undefined {
      if (!isOwnerScopedKey(key)) {
        throw new Error(
          `getForOwner: "${key}" is a deployment-global config key, not owner-scoped — use get() instead.`,
        )
      }
      const raw = getOwnerStmt.get(ownerId, key)?.value
      if (raw !== undefined) return decryptRaw(raw)
      // Fallback for the default owner only: covers the window between an
      // upgrade and the backfill migration having run (belt-and-suspenders —
      // migration 11 in migrations.ts should already cover this).
      if (ownerId !== DEFAULT_OWNER_ID) return undefined
      const legacyRaw = getStmt.get(key)?.value
      return legacyRaw === undefined ? undefined : decryptRaw(legacyRaw)
    },

    setForOwner(ownerId: string, key: string, value: string): void {
      if (!isOwnerScopedKey(key)) {
        throw new Error(
          `setForOwner: "${key}" is a deployment-global config key, not owner-scoped — use set() instead.`,
        )
      }
      const stored = encryptor && secretKeys.has(key) ? encryptor.encrypt(value) : value
      setOwnerStmt.run(ownerId, key, stored)
      // Mirror the default owner's writes into the legacy deployment-global
      // `config` table too. This is what keeps every *unmigrated* reader (any
      // call site still on the plain get() path, e.g. prStatus.ts/gitDriver.ts)
      // seeing byte-identical values across this change — the acceptance
      // criterion for this migration. Any owner other than the default is never
      // mirrored: their data is genuinely isolated, never touching or being
      // visible via the shared global row.
      if (ownerId === DEFAULT_OWNER_ID) setStmt.run(key, stored)
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
