import { createHash, timingSafeEqual } from 'node:crypto'
import type { Identity } from '../shared/contract.js'

/** The single owner in the local (free) tier. */
export const LOCAL_IDENTITY: Identity = { id: 'local' }

// Constant-time comparison against fixed-length SHA-256 hashes so a wrong
// token doesn't leak the expected token's length via timing.
function constantTimeEquals(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest()
  const bh = createHash('sha256').update(b).digest()
  return timingSafeEqual(ah, bh)
}

/** Minimal shape auth.ts needs from a device token store (see
 *  electron/services/deviceTokenStore.ts). Kept structural so this module
 *  stays free of any dependency on better-sqlite3 or the services layer. */
export interface DeviceTokenResolver {
  resolveToken(token: string): Identity | undefined
}

export interface ResolveIdentityOpts {
  /** The deployment-wide SLIPSTREAM_TOKEN. Always maps to LOCAL_IDENTITY —
   *  this is the single-user/local tier default and never regresses. */
  staticToken: string
  /** Per-device/per-user token store (FLO-143) — the multi-user seam. Optional
   *  so callers that haven't wired one up (tests, single-user-only
   *  deployments) still work: any token that isn't the static token is then
   *  simply unresolvable. */
  deviceTokens?: DeviceTokenResolver
}

/**
 * Resolve a presented bearer token to a caller identity.
 *
 * - The static `SLIPSTREAM_TOKEN` always maps to `LOCAL_IDENTITY` — the
 *   single-user/local tier default, unchanged from before FLO-143.
 * - Any other token is looked up in the per-device token store: a distinct,
 *   individually-revocable credential mapping to a distinct owner. Returns
 *   `undefined` (auth rejected) if the token is neither the static token nor
 *   a live (non-revoked) entry in the store.
 */
export function resolveIdentity(token: string, opts: ResolveIdentityOpts): Identity | undefined {
  if (constantTimeEquals(token, opts.staticToken)) return LOCAL_IDENTITY
  return opts.deviceTokens?.resolveToken(token)
}
