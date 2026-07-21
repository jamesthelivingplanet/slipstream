import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  insertDeviceToken,
  getDeviceTokenByHash,
  getDeviceToken,
  allDeviceTokens,
  revokeDeviceToken,
  type DeviceTokenRow,
} from '../db/db.js'
import type { Identity } from '../shared/contract.js'

/** A device/user credential's metadata — safe to hand to a caller (never
 *  carries the plaintext token or its hash). */
export interface DeviceTokenDTO {
  id: string
  ownerId: string
  label: string
  createdAt: number
  revokedAt: number | null
}

export interface IDeviceTokenStore {
  /** Mint a new credential for `ownerId`. The plaintext `token` is returned
   *  ONLY here — it is never persisted or retrievable again, only its hash
   *  is (see hashToken below). */
  issue(ownerId: string, label: string): { token: string; dto: DeviceTokenDTO }
  list(): DeviceTokenDTO[]
  get(id: string): DeviceTokenDTO | undefined
  /** Revoke a single credential. Final, not a toggle; a missing or
   *  already-revoked id is a silent no-op (idempotent). */
  revoke(id: string): void
  /** Resolve a presented bearer token to its owning Identity, or undefined if
   *  unknown or revoked. This is the multi-user half of resolveIdentity (see
   *  electron/core/auth.ts, docs/IDENTITY-SEAM.md). */
  resolveToken(token: string): Identity | undefined
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toDTO(row: DeviceTokenRow): DeviceTokenDTO {
  return {
    id: row.id,
    ownerId: row.ownerId,
    label: row.label,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  }
}

/** DB-backed per-device/per-user token store (FLO-143) — the credential
 *  source behind resolveIdentity's multi-user seam. Every credential is a
 *  random 256-bit value; only its SHA-256 hash ever touches disk. */
export function createDeviceTokenStore(db: Database.Database): IDeviceTokenStore {
  return {
    issue(ownerId, label) {
      const token = `dt_${randomBytes(32).toString('base64url')}`
      const row: DeviceTokenRow = {
        id: randomUUID(),
        ownerId,
        tokenHash: hashToken(token),
        label,
        createdAt: Date.now(),
        revokedAt: null,
      }
      insertDeviceToken(db, row)
      return { token, dto: toDTO(row) }
    },
    list() {
      return allDeviceTokens(db).map(toDTO)
    },
    get(id) {
      const row = getDeviceToken(db, id)
      return row ? toDTO(row) : undefined
    },
    revoke(id) {
      revokeDeviceToken(db, id, Date.now())
    },
    resolveToken(token) {
      const row = getDeviceTokenByHash(db, hashToken(token))
      if (!row || row.revokedAt !== null) return undefined
      return { id: row.ownerId }
    },
  }
}
