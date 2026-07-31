import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { Identity } from '../shared/contract.js'

/**
 * Self-service device onboarding (docs/SECURITY.md, "Device pairing codes"
 * section; docs/IDENTITY-SEAM.md's open item 2). An already-authenticated
 * session mints a short-lived, single-use code (createPairingCode RPC, see
 * electron/core/rpcHandlers/pairing.ts) bound to ITS OWN resolved identity; a
 * brand-new, not-yet-authenticated device redeems it at the unauthenticated
 * `POST /pair` HTTP endpoint (electron/server/server.ts) for a real device
 * token minted via deviceTokenStore.issue(). This module is the in-memory
 * store + HTTP-layer rate limiter behind that redemption endpoint — modeled
 * directly on wsTickets.ts's single-use/short-TTL shape, with the extra
 * defenses called out below because, unlike every other endpoint in
 * server.ts, `/pair` is reachable with NO credential at all.
 */

// A pairing code only needs to survive the short walk from "look at the
// authenticated device's screen" to "key/scan it into the new device" — not a
// session lifetime. 5 minutes is generous slack for that without leaving a
// usable, credential-shaped secret sitting around for long.
export const PAIRING_CODE_TTL_MS = 5 * 60_000
const SWEEP_INTERVAL_MS = 30_000

// Entropy: 16 random bytes (128 bits), base64url-encoded (~22 chars) — the
// same generation shape as deviceTokenStore's token and wsTickets' ticket,
// just single-use and short-lived like the ticket.
//
// Why this is enough against brute force, given the rate limit below: /pair
// is rate-limited to PAIR_RATE_LIMIT_MAX (10) attempts per PAIR_RATE_LIMIT_WINDOW_MS
// (60s) *per source IP*. Over a code's whole PAIRING_CODE_TTL_MS (5 min)
// lifetime that caps any single IP at ~50 guesses. Against a keyspace of
// 2^128 (~3.4e38) possible codes, the probability of a correct guess in 50
// attempts is on the order of 50 / 3.4e38 — indistinguishable from zero. An
// attacker would additionally need to spread guesses across many distinct
// IPs to even reach that many attempts (each IP is independently capped),
// which only makes the already-negligible odds harder to realize in
// practice, not easier.
const CODE_BYTES = 16

interface PairingEntry {
  ownerId: string
  expiresAt: number
  used: boolean
}

export interface DevicePairingStore {
  /** Mint a single-use pairing code bound to `identity.id` — the CALLER's
   *  resolved identity (from RpcContext), never a client-supplied ownerId.
   *  Valid for the store's configured TTL. */
  issue(identity: Identity): { code: string; expiresAt: number }
  /**
   * Redeem a code: valid + unused + unexpired -> marks it used (atomically,
   * synchronously, before anything else can observe it — see the comment in
   * the implementation) and returns the bound ownerId. Anything else
   * (unknown, expired, already-used) returns undefined, indistinguishable to
   * the caller — this is what lets POST /pair return one uniform error for
   * every failure case instead of leaking which one occurred.
   */
  redeem(code: string): string | undefined
  /** Stop the expiry sweeper (call on server shutdown / test teardown). */
  dispose(): void
}

// Mirrors deviceTokenStore.ts's hashToken: only the SHA-256 hash of a code is
// ever held in memory, never the plaintext, so a heap dump (or, if this store
// is ever backed by persistence later) doesn't hand out usable codes.
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

// Constant-time membership check for the (small — bounded by the rate limiter
// and the short TTL) set of live codes. Hashing first (see hashCode) already
// converts "does a raw secret comparison leak its length/prefix via timing"
// into "does a fixed-length SHA-256 digest comparison leak anything" — with
// preimage resistance, a timing side-channel on the digest compare cannot be
// inverted back to structure of the original random code. This scans every
// live entry with `timingSafeEqual` (rather than a plain Map#get on the hash,
// which would rely on V8's internal string equality) so the comparison
// itself never short-circuits on the presented value.
function findByCode(codes: Map<string, PairingEntry>, code: string): string | undefined {
  const presented = Buffer.from(hashCode(code), 'hex')
  for (const hash of codes.keys()) {
    const stored = Buffer.from(hash, 'hex')
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) return hash
  }
  return undefined
}

export function createDevicePairingStore(ttlMs: number = PAIRING_CODE_TTL_MS): DevicePairingStore {
  const codes = new Map<string, PairingEntry>() // hash(code) -> entry

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [hash, entry] of codes) {
      if (entry.used || entry.expiresAt <= now) codes.delete(hash)
    }
  }, SWEEP_INTERVAL_MS)
  sweeper.unref?.()

  return {
    issue(identity) {
      const code = randomBytes(CODE_BYTES).toString('base64url')
      const expiresAt = Date.now() + ttlMs
      codes.set(hashCode(code), { ownerId: identity.id, expiresAt, used: false })
      return { code, expiresAt }
    },

    redeem(code) {
      const hash = findByCode(codes, code)
      if (!hash) return undefined
      const entry = codes.get(hash)!
      // Mark used before anything else, synchronously — Node never preempts
      // this handler mid-execution, so two requests racing the same code
      // cannot both observe used:false (see server.test.ts's concurrent
      // double-redeem test). Checked AFTER the lookup but as the very next
      // statement, with no `await` in between.
      if (entry.used || entry.expiresAt <= Date.now()) return undefined
      entry.used = true
      return entry.ownerId
    },

    dispose() {
      clearInterval(sweeper)
    },
  }
}

// ── /pair rate limiter ──────────────────────────────────────────────────────
//
// Independent of code entropy — defends against an attacker who doesn't even
// have a code and is trying to enumerate the (tiny, short-lived) live set by
// brute force, and bounds request volume against this one deliberately
// unauthenticated endpoint regardless. Fixed window, keyed by source IP.
export const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
export const PAIR_RATE_LIMIT_MAX = 10

export interface PairRateLimiter {
  /** True if `key` (source IP) may make another /pair attempt right now. */
  allow(key: string): boolean
  dispose(): void
}

export function createPairRateLimiter(
  windowMs: number = PAIR_RATE_LIMIT_WINDOW_MS,
  max: number = PAIR_RATE_LIMIT_MAX,
): PairRateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>()

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs) hits.delete(key)
    }
  }, windowMs)
  sweeper.unref?.()

  return {
    allow(key) {
      const now = Date.now()
      const entry = hits.get(key)
      if (!entry || now - entry.windowStart > windowMs) {
        hits.set(key, { count: 1, windowStart: now })
        return true
      }
      if (entry.count >= max) return false
      entry.count++
      return true
    },
    dispose() {
      clearInterval(sweeper)
    },
  }
}
