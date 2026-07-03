# Identity Seam

FLO-48. The identity seam is how Slipstream stays additive as it moves up the
[open-core ladder](POSITIONING.md) toward a paid team self-host tier. The
[ROADMAP D3 phase](ROADMAP.md) adds per-owner data isolation — the seam is
the cut point. Change the seam; don't touch call sites.

## The model

Every RPC request resolves to an `Identity` — `{ id: string }` from
`electron/shared/contract.ts`. Today `resolveIdentity(token)` in
`electron/core/auth.ts` maps every valid bearer token to `LOCAL_IDENTITY`
(`{ id: 'local' }`). The seam is where a future multi-user tier maps
distinct tokens → distinct owners without touching anything downstream.

## Where identity is resolved

`electron/server/server.ts` resolves it **once**, at WebSocket upgrade, from
the validated bearer token, then threads it into `createRpc({ identity })`.
The Electron desktop is a thin client of this same daemon (post-FLO-47) —
one choke point, no other entry path.

## Storage

`repos` and `sessions` both carry a nullable `ownerId TEXT DEFAULT 'local'`
column, added as additive `ALTER TABLE` migrations in `openDb` (`electron/db/db.ts`).
Legacy rows with `NULL` coalesce to `'local'` at the predicate level — no
backfill migration needed.

## Enforcement in `electron/core/rpc.ts`

- **Predicate**: `ownedByCaller(row)` — `(row.ownerId ?? 'local') === identity.id`.
- **Enumerations filtered**: `listRepos` and `listSessions` pass every row through
  `ownedByCaller` before returning.
- **Creation stamped**: `startSession` writes `ownerId: identity.id` to the session
  row; `registerRepo` passes `identity.id` as the second arg to
  `IRepoRegistry.register`, which writes it into the repo row.
- **Single-item session guards** via `ownedSession(id)` (returns `undefined` for
  missing or other-owner rows): `resumeSession`, `attachRemoteControl`,
  `cleanupSession`, `getSessionBuffer`, `writeSession`, `resizeSession`,
  `killSession`, `attachSession`, `takeWrite`, `detachSession`. The last two
  pairs — `attachSession`/`takeWrite` — are a nuance: instead of returning
  `undefined` they return a neutral `lockState(id)` (a `WriteLockState` as if
  the coordinator has no state for that session) so the caller gets a
  well-typed response without being attached as a viewer or granted the
  write lock.
- **Single-item repo guards** via `requireOwnedRepo(repoId)` (throws `Unknown repo`
  for missing or other-owner rows): `worktreeStatus`, `openInEditor`, `runApp`,
  `getRepoSettings`, `setRepoSettings`, `removeRepo`, and `startSession`'s repo
  resolution.
- **No existence leak**: cross-owner access surfaces an identical error to a missing
  row (`Session not found` / `Unknown repo`).

## Single-user invariant

Identity is always `'local'`, every row is `'local'`, every ownership check
passes — behavior is byte-for-byte identical to the pre-seam code. This is
locked in by `electron/core/auth.test.ts` (identity resolution) and
`electron/core/rpc.test.ts` (ownership guards on each handler).

## Known follow-up for true multi-user

`writeSession`, `resizeSession`, `killSession`, `attachSession`, `takeWrite`,
and `detachSession` are fire-and-forget control ops addressed by an
unguessable uuid session id. They are now owner-guarded via `ownedSession`,
but because they're fire-and-forget they silently no-op for a missing or
other-owner session — `undefined` for `writeSession`/`resizeSession`/
`killSession`/`detachSession`, or a neutral, non-attaching `lockState(id)`
for `attachSession`/`takeWrite` — rather than throwing, preserving the
no-existence-leak invariant used elsewhere in this file. This does require
the session to be persisted (owned) in `sessionStore`, which is always true
after `startSession`, so there's no practical behavior change for legitimate
callers.

Remaining genuine follow-ups: give `resolveIdentity` a real token → owner
store (today every valid token maps to `LOCAL_IDENTITY`), and decide between
per-owner data-dir vs row-level isolation for the eventual multi-user tier.

## Readiness for per-device / per-user tokens

FLO-84. A security-review pass over auth flagged the single static token as
the first thing to change for a multi-user tier — this section records what
that change touches and what it doesn't, so it isn't re-derived later. See
also [docs/SECURITY.md](SECURITY.md) for the one-time WS ticket design this
seam also needs to accommodate.

### What's already there

- `resolveIdentity(token)` (`electron/core/auth.ts`) — the single choke point
  that maps a bearer token to an `Identity`. Called exactly once per
  connection, at WebSocket upgrade (`electron/server/server.ts`), and threaded
  into `createRpc({ identity })` from there. No other entry path exists.
- `ownerId` columns — nullable `ownerId TEXT DEFAULT 'local'` on both `repos`
  and `sessions`, added as additive `ALTER TABLE` migrations, with legacy
  `NULL` rows coalescing to `'local'` at the predicate level.
- `ownedByCaller(row)` predicate, enumeration filtering (`listRepos`,
  `listSessions` in `electron/core/rpc.ts` only return rows the caller owns),
  and the single-item guards (`ownedSession`, `requireOwnedRepo`) covering
  every read/write call site listed above.
- The no-existence-leak invariant: a cross-owner access gets the identical
  error a missing row would (`Session not found` / `Unknown repo`), so
  ownership can't be probed by comparing error messages.

Net effect: **every downstream call site is already owner-scoped.** Going
multi-user is a change *at the seam* (`resolveIdentity` and whatever feeds it),
not a change at any of the ~15 guarded call sites — those don't need to know
or care how many distinct identities exist.

### What multi-user token rotation still needs

1. **A real token → owner store.** Today `resolveIdentity(_token)` ignores its
   argument and always returns `LOCAL_IDENTITY` — there is exactly one owner.
   Multi-user needs this to become a lookup (DB table or similar) mapping each
   issued token to a distinct owner id.
2. **Per-device/per-user token issuance + onboarding.** A way to mint a new
   token for a new device/user and get it onto that device — today onboarding
   is "here's the one `SLIPSTREAM_TOKEN` value, put it in the URL or
   localStorage" (see `scripts/deploy.sh`'s QR-code onboarding flow).
3. **Revocation granularity.** Today "rotate" means edit `server.env` and
   re-onboard *every* device, because there's only one token. Multi-user needs
   to revoke one token (one compromised device, one departing user) without
   disturbing any other token's validity.
4. **Integration with the one-time WS ticket endpoint** (docs/SECURITY.md,
   §3 — design only, not yet implemented). Tickets need to be minted per-token,
   not per-deployment: `POST /rpc-ticket`'s `Authorization: Bearer` check
   resolves an identity via this same seam, and the ticket's stored `identity`
   field is what the upgrade handler uses on redemption. The ticket design
   composes with per-user tokens for free *if* the token store from item 1
   above is in place first — the ticket endpoint doesn't need its own identity
   logic, just to call `resolveIdentity()` like the upgrade handler already
   does.
5. **The still-open per-owner-data-dir vs. row-level-isolation decision**
   (carried over from the "Known follow-up" section above) — multi-user token
   rotation is orthogonal to this, but both land in the same eventual
   multi-user milestone and should be designed together rather than
   sequentially discovering conflicts.
