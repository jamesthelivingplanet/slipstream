# Identity Seam

FLO-48. The identity seam is how Slipstream stays additive on the path to a paid
team self-host tier: it isolates data per owner today (single user) without
forcing a rewrite when real multi-user arrives. The seam is the cut point —
change the seam, don't touch call sites.

## The model

Every RPC request resolves to an `Identity` — `{ id: string }` from
`electron/shared/contract.ts`. `resolveIdentity(token, opts)` in
`electron/core/auth.ts` resolves a presented bearer token to that `Identity`:

- The deployment-wide `SLIPSTREAM_TOKEN` (`opts.staticToken`) always maps to
  `LOCAL_IDENTITY` (`{ id: 'local' }`) — the single-user/local tier default,
  unchanged since before FLO-143.
- Any other token is looked up in the per-device/per-user token store
  (`opts.deviceTokens`, FLO-143) — see "Per-device/per-user tokens" below.
  `undefined` means auth is rejected (identical whether the credential is
  wrong, unknown, or revoked — no signal leak).

## Where identity is resolved

`electron/server/server.ts` resolves it **once**, at WebSocket upgrade, from
the validated bearer token, then threads it into `createRpc({ identity })`.
The Electron desktop is a thin client of this same daemon (post-FLO-47) —
one choke point, no other entry path.

## Storage

`repos` and `sessions` both carry a nullable `ownerId TEXT DEFAULT 'local'`
column, added as additive `ALTER TABLE` migrations in `openDb` (`electron/db/db.ts`).
Legacy rows with `NULL` coalesce to `'local'` at the predicate level — no
backfill migration needed. `prompt_templates` (FLO-98) also carries
`ownerId TEXT DEFAULT 'local'` — its table is created by a numbered migration
in `electron/db/migrations.ts`, not the frozen baseline schema.

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
- **Prompt-template guards** (FLO-98): `listPromptTemplates` requires the owned
  repo (`requireOwnedRepo`) then filters rows through `ownedByCaller`;
  `savePromptTemplate` stamps `ownerId: identity.id` on new rows and guards
  updates (an `input.id` pointing at a missing *or* other-owner row throws
  `Template not found`); `deletePromptTemplate` guards via the same
  identical-error no-leak rule.
- **No existence leak**: cross-owner access surfaces an identical error to a missing
  row (`Session not found` / `Unknown repo` / `Template not found`).

## Single-user invariant

Identity is always `'local'`, every row is `'local'`, every ownership check
passes — behavior is byte-for-byte identical to the pre-seam code. This is
locked in by `electron/core/auth.test.ts` (identity resolution) and
`electron/core/rpc.test.ts` (ownership guards on each handler).

## Per-device/per-user tokens (FLO-143)

`electron/services/deviceTokenStore.ts` is a DB-backed store (`device_tokens`
table, migration 8 in `electron/db/migrations.ts`) of individually-issued,
individually-revocable credentials:

- **Issue**: `issue(ownerId, label)` mints a random 256-bit token
  (`dt_<base64url>`), persists only its SHA-256 hash (`tokenHash`), and returns
  the plaintext token exactly once — like an API key, it is never retrievable
  again after issuance, only its metadata (`DeviceTokenDTO`: id, ownerId,
  label, createdAt, revokedAt).
- **Look up**: `resolveToken(token)` hashes the presented token and looks it up
  by `tokenHash` (unique-indexed); a live (non-revoked) match resolves to
  `{ id: row.ownerId }`.
- **Revoke**: `revoke(id)` sets `revokedAt` once (`WHERE revokedAt IS NULL`) —
  final, not a toggle. A missing or already-revoked id is a silent idempotent
  no-op. `resolveToken` for a revoked credential returns `undefined`
  identically to an unknown token — the compromised device is cut off, every
  other credential (any owner, any device) keeps resolving exactly as before.

`server.ts`'s WS upgrade handler wires this into `resolveIdentity` (see "The
model" above) via `IpcDeps.deviceTokens` (optional — a deployment or test
without one just gets the static-token-only path, unchanged). Device tokens
flow through the *same* `?token=`/`Authorization: Bearer` presentation path as
the static token; no client-side change is required to support them.

There is deliberately no RPC/UI surface yet for self-service issuance — that
was called out as a separate, later item (onboarding UX, below) from the store
itself. What does exist is an **operator/admin CLI**,
`electron/cli/manageTokens.ts` (built to `dist-electron/manage-tokens.js`,
run via `pnpm tokens -- <issue|list|revoke> ...` under
`ELECTRON_RUN_AS_NODE=1`, same ABI trick `pnpm serve` uses — see
docs/NATIVE-MODULES.md): an operator runs `issue <ownerId> <label>` to mint a
new device/user's first credential and hand it to that device as its
`SLIPSTREAM_TOKEN`, `list` to see every issued credential, and `revoke <id>`
to cut one off. This is deliberately not agent-facing or end-user-facing (an
operator/admin action, not a per-owner RPC) — a future onboarding UX (item 2
below) would likely wrap this same store in an RPC/UI, not replace it.

## What true multi-user still needs

Every downstream call site is already owner-scoped (see Enforcement above), so
going multi-user was a change *at the seam* (FLO-143, above) — none of the ~15
guarded handlers needed to know or care how many distinct identities exist.

One current-behavior caveat to carry forward: `writeSession`, `resizeSession`,
`killSession`, `attachSession`, `takeWrite`, and `detachSession` are
fire-and-forget control ops addressed by an unguessable uuid. They are
owner-guarded via `ownedSession`, but because they're fire-and-forget they
silently no-op for a missing or other-owner session (`undefined`, or a neutral
non-attaching `lockState(id)` for `attachSession`/`takeWrite`) rather than
throwing — preserving the no-existence-leak invariant. This requires the session
to be persisted (owned) in `sessionStore`, which is always true after
`startSession`, so there's no practical behavior change for legitimate callers.

What's still open for a full multi-user milestone:

1. ~~A real token → owner store.~~ Done (FLO-143, above).
2. **End-user-facing onboarding UX.** The operator/admin CLI (above) covers
   *minting* a credential, but getting it onto the new device is still manual
   (copy the printed token into that device's config) — there's no QR-code
   -style onboarding flow the way the single static `SLIPSTREAM_TOKEN` has
   (see `scripts/deploy.sh`), and no self-service RPC/UI for a logged-in user
   to add a second device of their own without an operator running the CLI.
3. ~~Revocation granularity.~~ Done (FLO-143, above) — `revoke(id)` disables
   exactly one credential without touching any other.
4. **Integration with the one-time WS ticket endpoint** ([docs/SECURITY.md](SECURITY.md)
   §3 — design only, not yet implemented). Tickets must be minted per-token, not
   per-deployment: `POST /rpc-ticket`'s `Authorization: Bearer` check resolves an
   identity via this same seam, and the ticket's stored `identity` field is what
   the upgrade handler uses on redemption. The ticket design composes with
   per-user tokens for free now that the token store (item 1) is in place.
5. **The per-owner-data-dir vs. row-level-isolation decision.** Orthogonal to
   token rotation, but both land in the same multi-user milestone and should be
   designed together rather than sequentially discovering conflicts.
6. **Per-owner integration config.** The `config` table (Linear/Jira
   credentials, git tokens, editor command, GC policy) is deployment-global
   today — every owner would currently share one set of ticket-provider
   credentials, and the FLO-98 ticket write-back posts comments with those
   shared credentials. A multi-user tier needs config keys namespaced per owner
   (or a per-owner config table) before distinct users can connect their own
   trackers.
