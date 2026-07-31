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

## Per-owner integration config (FLO-48 item 6)

The `config` table is deployment-global — every owner on a deployment shares
one row per key. That's the right default for settings that describe the
daemon's own behavior (GC policy, scheduler policy, spawn policy, budget
policy, editor command, `agentArgs.<kind>`), but wrong for integration
credentials: two owners on the same deployment would reasonably want their
own Linear/Jira/git-host tokens, not one shared set. This splits config keys
into two classes rather than making the whole table per-owner:

- **Owner-scoped**: integration credentials (`linear.apiKey`,
  `jira.apiToken`, `github.token`, `gitlab.token`, `bitbucket.token`,
  `gitea.token`) plus the non-secret settings that ride along with them
  (ticket-source scoping like `linear.teamKeys`/`github.issueRepos`, git
  host `username`/`baseUrl`).
- **Deployment-global**: everything else, unchanged.

**Storage.** An additive `config_owner` table (`electron/db/migrations.ts`
migration 11), keyed by `(ownerId, key)`, sits alongside the untouched
deployment-global `config` table. `IConfigStore.getForOwner`/`setForOwner`
(`electron/services/configStore.ts`) are optional on the interface — every
hand-rolled `IConfigStore` fake elsewhere in the test suite keeps compiling
unchanged — but the real store returned by `createConfigStore` always
implements both. Classification is enforced by `isOwnerScopedKey`/
`OWNER_SCOPED_PREFIXES` (a namespace-prefix match, not an enumerated key
list, so a new key under an existing integration namespace is automatically
classified correctly): `getForOwner`/`setForOwner` throw if called with a
deployment-global key.

**Zero behavior change for single-owner deployments.** `setForOwner`
mirrors every write for `DEFAULT_OWNER_ID` (`'local'`) back into the legacy
global `config` table, and `getForOwner(DEFAULT_OWNER_ID, key)` falls back
to the legacy global value when `config_owner` has no row yet (belt-and-
suspenders alongside migration 11's backfill). This is what keeps every
*unmigrated* reader — anything still on the plain `get()` path, e.g.
`electron/services/prStatus.ts`/`electron/services/gitDriver.ts` — seeing
correct, up-to-date values: the migration's acceptance criterion. A
non-default owner's data is never mirrored; it's genuinely isolated.

**What's wired end-to-end today.** `electron/core/rpcHandlers/config.ts`'s
git host token/config RPCs (`getGitToken`/`setGitToken`/`getGitHostConfig`/
`setGitHostConfig`) are fully owner-scoped via the caller's resolved
identity (`ctx.identity.id`) — a non-default owner's git host credentials
are genuinely isolated at the storage/API layer.

Ticket-provider credentials (linear/jira/github/gitlab) are now genuinely
isolated per owner too, closing what was previously the gap in this
section:

- `electron/tickets/linearProvider.ts` takes an `ownerId` constructor
  parameter (`ownerId: string = DEFAULT_OWNER_ID`) and uses
  `config.getForOwner!(ownerId, 'linear.apiKey')`/
  `config.setForOwner!(ownerId, ...)` throughout, including its
  `setSettings`. The old blocker — a legacy duplicate write path
  (`getLinearKey`/`setLinearKey` in `electron/core/rpcHandlers/tickets.ts`)
  writing the same `linear.apiKey` key directly to the deployment-global
  table, which would have desynced from a migrated linearProvider.ts — is
  closed: those two handlers now also go through
  `deps.config.getForOwner!(ctx.identity.id, 'linear.apiKey')`/
  `setForOwner!(ctx.identity.id, 'linear.apiKey', ...)`, so both writers
  share one accessor.
- jira/github/gitlab (`jiraProvider.ts`, `githubIssuesProvider.ts`,
  `gitlabIssuesProvider.ts`) already had the same `ownerId` constructor
  parameter; what closes their gap is that a real per-request identity now
  actually reaches them.
- That's because `electron/core/services.ts` no longer builds one singleton
  `ITicketProvider` per source at startup. It now exposes
  `ticketProvidersForOwner(ownerId)`/`ticketsForOwner(ownerId)` factory
  functions — a fresh instance per call (provider construction has no I/O,
  so this is cheap and always reads live config) — threaded through as the
  `tickets`/`ticketProviders` deps (now functions, not static objects)
  passed to IPC handlers.
- The ticket RPC handlers (`listTickets`/`getTicketStatus`/
  `setTicketStatus`/`getTicketSettings`/`setTicketSettings`/
  `listTicketScopes`) resolve `deps.ticketProviders?.(ctx.identity.id)` —
  the caller's real identity, not a fixed default. Other call sites resolve
  real identity the same way: session cleanup's ticket-reset
  (`electron/core/rpcHandlers/sessions.ts`) uses `ctx.identity.id`; session
  launch's ticket-start (`electron/services/sessionLauncher.ts`) uses the
  launch request's `ownerId`; the daemon-level PR ticket-writeback
  (`electron/services/ticketWriteback.ts`, wired via
  `electron/core/wirePrEventListeners.ts`) resolves the provider from the
  session's own persisted `ownerId` (falling back to `'local'` for legacy
  rows, same pattern as every other owner-scoped read).

**What's still not wired end-to-end, disclosed honestly:**

- Downstream git-operation consumers of `${host}.token`/`username`/
  `baseUrl` still read only the deployment-global table:
  `electron/services/prStatus.ts` (`deps.config.get(\`${host}.token\`)`,
  `deps.config.get(\`${host}.username\`)`, `deps.config.get(\`${host}.baseUrl\`)`)
  and `electron/cli/slipstream.ts` (`cachedConfigStore?.get(\`${host}.token\`)`
  etc.) call the plain `.get()` path directly; `electron/services/gitDriver.ts`
  doesn't call `config.get` itself but receives host config via an injected
  `getHostConfig` callback, and its only real caller (`slipstream.ts`)
  sources that callback from the same plain deployment-global `.get()`
  calls. This is safe today (thanks to the default-owner mirroring above)
  but means a non-default owner's own saved git credentials aren't yet used
  for their own git pushes/PR status — only the Settings-facing API layer
  and (as of above) the ticket-provider layer are isolated per-owner so
  far.

Item 5 below (per-owner data directories) is orthogonal and still open,
unaffected by this change.

What's still open for a full multi-user milestone:

1. ~~A real token → owner store.~~ Done (FLO-143, above).
2. ~~End-user-facing onboarding UX.~~ Done — the self-service RPC/UI already
   existed before this pass: `createPairingCode()`
   (`electron/core/rpcHandlers/pairing.ts`), the in-memory store
   (`electron/services/devicePairing.ts`), and the unauthenticated
   `POST /pair` redemption endpoint, all documented in
   [docs/SECURITY.md](SECURITY.md) §13. Its UI
   (`src/lib/components/settings/SettingsSecurity.svelte`'s "Pair a device"
   section) shows the short-lived code and a QR code (deep-linking
   `#pair=<code>`, via the same `qrcode` dependency already used by
   `SettingsIntegrations.svelte`'s token-pairing-link QR) — so a QR-style
   flow was never actually missing. What *was* newly fixed in this pass:
   `src/lib/components/SettingsModal.svelte`'s "Security" tab button used to
   render conditionally on `nativeStorage.isAvailable()` (Capacitor
   mobile-only), so this pairing UI was unreachable from an already-
   authenticated desktop/web session — only mobile could get to it. That
   gate is now removed for the tab button and its content (the "Server" tab,
   Capacitor-only daemon-URL config, stays native-gated, unrelated), so a
   logged-in desktop/web user can now self-service-add a second device
   without an operator running `manageTokens.ts`.
3. ~~Revocation granularity.~~ Done (FLO-143, above) — `revoke(id)` disables
   exactly one credential without touching any other.
4. ~~Integration with the one-time WS ticket endpoint.~~ Done (FLO-144,
   [docs/SECURITY.md](SECURITY.md) §3) — tickets are minted per-token, not
   per-deployment: `POST /rpc-ticket`'s `Authorization: Bearer` check resolves an
   identity via this same seam, and the ticket's stored `identity` field is what
   the upgrade handler redeems on the `?ticket=` branch. The ticket design
   composed with per-user tokens for free once the token store (item 1) was in
   place.
5. **The per-owner-data-dir vs. row-level-isolation decision.** Orthogonal to
   token rotation, but both land in the same multi-user milestone and should be
   designed together rather than sequentially discovering conflicts.
6. ~~Per-owner integration config.~~ Done (FLO-48, above) — see "Per-owner
   integration config" above. The config-storage/API layer is fully
   owner-scoped, and the ticket-provider credential gap (linear/jira/
   github/gitlab) disclosed there is now also closed end-to-end. This does
   not mean identity/config is fully finished, though: item 5 (per-owner
   data directories) remains open, and the git-push/PR-status credential
   gap (`prStatus.ts`/`gitDriver.ts`/`slipstream.ts` still reading the
   plain deployment-global `config.get()` path) described in that same
   section also remains open.
