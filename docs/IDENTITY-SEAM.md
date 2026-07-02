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
