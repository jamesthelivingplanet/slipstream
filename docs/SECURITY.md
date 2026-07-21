# Security notes

FLO-84. Design notes for auth-adjacent hardening that's either already shipped or
deliberately deferred. See [docs/IDENTITY-SEAM.md](IDENTITY-SEAM.md) for the
per-owner identity model these designs plug into.

## 1. Current auth model

A single static `SLIPSTREAM_TOKEN` (set via `server.env`, checked at process start
in `electron/server/server.ts`) authenticates every WebSocket RPC connection.
Clients present it one of two ways at `/rpc` upgrade time:

- **`Authorization: Bearer <token>`** — for header-capable clients (the Electron
  desktop's daemon connection, `scripts/e2e/*` drivers, anything scripted).
- **`?token=<token>` query parameter** — for the browser client
  (`src/lib/wsApi.ts`), because **browsers cannot set custom headers on a
  WebSocket upgrade request**. This is the only way a plain `new WebSocket(url)`
  call can carry a credential.

`tokensMatch()` in `server.ts` compares SHA-256 digests of the provided vs.
expected token with `crypto.timingSafeEqual`, so a wrong guess doesn't leak the
correct token's length via timing. The resolved token is then passed through
`resolveIdentity()` (`electron/core/auth.ts`) into `createRpc({ identity })` —
see IDENTITY-SEAM.md for what happens downstream.

This is fine as deployed today: Tailscale HTTPS (the recommended remote-access
path, `SLIPSTREAM_SERVE=tailscale`) is an encrypted tunnel with no intermediary
that could log the URL, and the Electron desktop talks to a `127.0.0.1` daemon
that never leaves the machine.

## 2. Threat: `?token=` in reverse-proxy access logs

README.md's "Local-only" remote-access path (`SLIPSTREAM_SERVE=none`) explicitly
tells self-hosters to bring their own HTTPS front door — a Cloudflare Tunnel, or
a reverse proxy (Caddy/nginx) with a Let's Encrypt cert — in front of
`http://127.0.0.1:7421`. The moment that happens, the full WebSocket upgrade URL,
**including `?token=`**, is exactly what a standard access-log line records on
every request. And this isn't a one-time cost: `wsApi.ts`'s `scheduleReconnect()`
retries with backoff (`RECONNECT_DELAYS`, capping at 10s) on every drop, so the
tokenized URL recurs in the log on every reconnect for as long as the client is
online.

A static, long-lived token landing in a log file — one that's often shipped to a
log aggregator, retained for weeks, and readable by anyone with proxy-host
access — is a durable credential leak. It defeats the constant-time comparison
and the encrypted-transport story entirely, because the leak happens at rest,
downstream of TLS termination.

## 3. Designed fix: one-time WS ticket endpoint (implementation deferred)

Writing the design down now so it isn't re-derived when reverse-proxy fronting
is actually adopted. **Not implemented** — ship this design, defer the code,
until a deployment actually needs it (see Rollout/scoping below).

**Endpoint**: `POST /rpc-ticket`, authenticated via `Authorization: Bearer
<SLIPSTREAM_TOKEN>` — a header, which never lands in a URL or an access log. No
request body needed; the caller is already fully identified by the bearer
token.

**Response**: `{ "ticket": "<random 256-bit base64url>", "expiresInMs": ~10000 }`.

**Server-side storage**: an in-memory `Map<ticket, { identity, expiresAt, used:
false }>`, populated by the endpoint handler, with a periodic expiry sweeper
(same shape as the existing `heartbeat` interval in `server.ts`) that evicts
expired entries so the map doesn't grow unbounded. Properties:
- **Single-use**: redemption (see below) marks the entry `used: true`
  atomically before doing anything else; a second redemption attempt is
  rejected identically to an unknown ticket.
- **Short TTL** (~10s): a ticket only needs to survive the time between the
  `POST /rpc-ticket` response and the client's very next `new WebSocket(...)`
  call — not a session lifetime.

**Upgrade-handler change**: `server.ts`'s `httpServer.on('upgrade', ...)`
handler gains a `?ticket=` branch **checked before** the existing
`?token=`/`Authorization` branch:
1. If `url.searchParams.get('ticket')` is present, look it up in the ticket
   map. Missing, expired, or already-`used` → reject (same `ws.close(4001,
   'Unauthorized')` path used today for a bad token — no distinguishing
   signal between "bad ticket" and "bad token" to a network observer).
2. Otherwise mark it `used`, and resolve identity from the **stored** entry
   (not by re-deriving from a token) — the ticket already carries the
   identity that was resolved at `POST /rpc-ticket` time via the existing
   `resolveIdentity()` seam.
3. The `Authorization: Bearer` path is untouched — it stays available for
   header-capable clients indefinitely. The browser `?token=` path can be
   retired entirely once tickets ship, since it exists solely to work around
   the browser WebSocket header limitation that tickets also solve.

**Leak resistance**: even if a ticket does end up in a proxy access log, it's
already single-use and burns out within ~10 seconds. The replay window for an
attacker scraping logs in near-real-time is negligible, and unlike the static
token, a leaked ticket is worthless the moment it's been used once or has
aged out — there's no persistent credential to rotate.

### Client reconnect impact

`wsApi.ts` currently builds `fullUrl` once (`${opts.url}?token=${...}`) and reuses
it across every `connect()` call, including calls from `scheduleReconnect()`.
Under the ticket design, `connect()` must fetch a **fresh** ticket before each
`new WebSocket(...)` — including every automatic reconnect — via one `POST
/rpc-ticket` request carrying the `Authorization: Bearer` token from
`localStorage`. This changes `connect()` from synchronous (`ws = new WS(fullUrl)`)
to async (fetch ticket → build URL → construct the WebSocket), which needs
`scheduleReconnect()`'s `setTimeout` callback to await it and route failures back
into the same backoff path. The long-lived token itself never moves — it stays
in `localStorage`, and after this change is *only ever* sent as an
`Authorization` header (to `/rpc-ticket`), never in a URL.

### Rollout / scoping

Not every deployment needs this:
- **Electron desktop** talks to a `127.0.0.1` daemon with no reverse proxy in
  the path — nothing logs the URL. Keep `?token=` there.
- **Tailscale HTTPS** (`SLIPSTREAM_SERVE=tailscale`) is an encrypted tunnel
  with no intermediary logging plaintext URLs. Keep `?token=` there too.
- **Reverse-proxy-fronted** (`SLIPSTREAM_SERVE=none` + user-supplied
  Caddy/nginx/Cloudflare Tunnel) is the only case that actually needs tickets.

So this should be gated — e.g. a `SLIPSTREAM_SERVE` value or an explicit opt-in
env var that only the reverse-proxy path sets — rather than forced on every
deployment. Implementing it unconditionally for Tailscale/Electron would add a
network round-trip to every reconnect for zero security benefit there.

### Implementation checklist (deferred)

- [ ] `POST /rpc-ticket` handler in `server.ts` (or a small new module) +
      in-memory ticket store + expiry sweeper.
- [ ] `?ticket=` branch in the upgrade handler, checked before `?token=`.
- [ ] `wsApi.ts`: pre-connect ticket fetch, wired into both the initial
      `connect()` and `scheduleReconnect()`.
- [ ] Retire the browser `?token=` path once tickets ship end-to-end.
- [ ] Tests: ticket single-use + expiry + identity propagation
      (`electron/server/server.test.ts`), reconnect-refetches-ticket
      (`src/lib/wsApi.test.ts` if/when one exists).

## 4. Per-device/per-user tokens (FLO-143)

The single static `SLIPSTREAM_TOKEN` still authenticates as `LOCAL_IDENTITY` —
unchanged, and still the only credential the local/single-user tier needs. On
top of it, `electron/services/deviceTokenStore.ts` (DB-backed, `device_tokens`
table) issues distinct, individually-revocable credentials mapping to distinct
owners:

- **Issuance**: a random 256-bit token is minted and returned once; only its
  SHA-256 hash is ever persisted (`tokenHash`, unique-indexed). The plaintext
  is unrecoverable from the DB — same posture as the config-table secrets in
  §6, but via hashing rather than reversible encryption, since a token only
  ever needs to be *matched*, never decrypted back out.
- **Revocation**: `revoke(id)` sets `revokedAt` once (`WHERE revokedAt IS
  NULL`) — final, not a toggle, and idempotent for a missing/already-revoked
  id. A revoked token resolves identically to an unknown one (`undefined` →
  the WS upgrade closes with the same `4001`), so revoking one device gives no
  attacker-visible signal distinguishing "revoked" from "never existed" — and,
  critically, does not touch any other credential's `tokenHash` row, so no
  other device or owner is affected.
- **Resolution**: `electron/core/auth.ts`'s `resolveIdentity(token, opts)`
  checks the static token first (constant-time, as before), then falls back to
  `opts.deviceTokens.resolveToken(token)` — this is the `resolveIdentity` seam
  IDENTITY-SEAM.md describes, now with a real multi-owner backing store
  instead of a hard-coded `LOCAL_IDENTITY`. Device tokens are presented via
  the exact same `?token=`/`Authorization: Bearer` paths as the static token
  (see §1) — no new transport, no client-side change required.

**Issuing/listing/revoking a token**: `electron/cli/manageTokens.ts`, an
operator-only admin CLI (`pnpm tokens -- issue <ownerId> <label> | list |
revoke <id>`, run under `ELECTRON_RUN_AS_NODE=1` like `pnpm serve` — see
docs/NATIVE-MODULES.md). There is no self-service RPC/UI yet for an
already-authenticated user to mint their own second-device token, and no
onboarding flow beyond manually copying the printed token onto the new device
(see IDENTITY-SEAM.md's "What's still open" list, item 2).

**What this doesn't yet include**: per-owner data isolation beyond the
existing row-level `ownerId` scoping (see IDENTITY-SEAM.md item 5, the
per-owner-data-dir question).

## 5. `sandbox: false` on the BrowserWindow — Sandbox experiment (FLO-84)

**Outcome: SUCCEEDED.** `sandbox: false` was required because the preload
(`electron/preload.ts`) was built as ESM (`preload.mjs`), and Electron only
loads an ESM preload with the Chromium sandbox off. By the time of FLO-84 the
preload had shrunk to two things: parsing the `--slipstream-daemon=<base64>`
`additionalArguments` entry, and exposing `window.__slipstreamNative.pickFolder()`
via `ipcRenderer.invoke`. Neither needs ESM.

The fix compiled the preload to CommonJS instead:
- `vite.config.ts`'s preload build now sets `output: { format: 'cjs',
  entryFileNames: '[name].cjs' }` (package.json has `"type": "module"`, so the
  `.cjs` extension is what forces Node/Electron to load this one file as CJS
  despite that).
- `electron/main.ts` now points `preload:` at `preload.cjs` and sets
  `sandbox: true`. `contextIsolation` was already at its safe default and is
  unaffected.
- The post-build guard (formerly `scripts/check-preload-esm.mjs`, asserting no
  bare `require()` in an ESM output) was inverted into
  `scripts/check-preload-cjs.mjs`, asserting no top-level `import`/`export` in
  a CJS output. `require('electron')` in the bundled output is expected and
  fine — sandboxed preloads whitelist it.

Verification performed: `pnpm build` produced `dist-electron/preload.cjs` (no
`preload.mjs`); `node scripts/check-preload-cjs.mjs` passed; the bundled output
was inspected and confirmed to use `require('electron')`, contain no top-level
`import`/`export`, and retain both the `--slipstream-daemon=` arg-parse and the
`contextBridge.exposeInMainWorld` picker calls intact; `pnpm check`, `pnpm
lint`, and `pnpm test` (551 tests) all passed. Actually clicking the folder
picker in a running window was not exercised in this environment (no way to
launch Electron headlessly here and drive the picker) — the evidence above
(well-formed CJS bundle with the arg-parse and picker logic present, build +
guard + full test suite green) is the basis for calling this a success rather
than a runtime click-through.

## 6. Secrets at rest

Config-table secrets — the Linear API key, GitHub/GitLab/Gitea/Bitbucket tokens,
the Jira API token, and the raw Firebase service-account key — are stored in the
SQLite `config` table inside the app's data directory (`<dataDir>/slipstream.db`).
VAPID keys (for Web Push) live there too, which is expected: they're server
credentials, not user secrets.

`configStore.ts` distinguishes ciphertext from plaintext by a marker prefix and
reads all forms transparently:

- `ss1:` — Electron `safeStorage` (desktop OS keychain).
- `sk1:` — server-key AES-256-GCM (FLO-145), used where no keychain is reachable.
- no prefix — legacy plaintext.

An encrypted value is only ever decrypted by the encryptor whose marker it
carries; a value the active process can't decrypt reads back as **absent**, never
as raw ciphertext handed to a caller.

**Encrypted on the desktop.** Where a real Electron process with an OS keychain is
available, values are `safeStorage`-encrypted (`ss1:`).

**Encrypted on the daemon / headless server (FLO-145).** The detached local daemon
and the headless `pnpm serve` server both run under `ELECTRON_RUN_AS_NODE=1`, where
`safeStorage` is unavailable. There `configStore.ts` falls back to a non-keychain
AES-256-GCM encryptor (`sk1:`), keyed one of two ways:

- **`SLIPSTREAM_SECRET` (operator passphrase, preferred).** The key is derived via
  scrypt from the env-supplied passphrase and a per-install random salt persisted
  at `<dataDir>/secret.salt`. The key itself never touches disk.
- **File-backed key (zero-config fallback).** If `SLIPSTREAM_SECRET` is unset, a
  random 32-byte key is generated once and persisted at `<dataDir>/secret.key`
  (0600, inside the 0700 data dir).

**Threat model — what this buys.** With `sk1:` encryption in place, the config
secrets are **not recoverable from `slipstream.db` alone**: a stolen DB file, a
leaked backup, or a snapshot of just the database yields ciphertext. Under the
`SLIPSTREAM_SECRET` path this holds even against theft of the *entire* data dir,
because the key lives only in the operator's env / secret store, not on disk.

**What it does NOT protect against.** The file-backed fallback does not defend
against an attacker who can read the whole data dir — they get `secret.key` too.
And neither mode defends against a **same-uid reader**: a process running as the
daemon's own uid can read the key file (or `SLIPSTREAM_SECRET` from the process
environment) and the DB alike. That is the deliberately-unclosed gap documented in
§7 — encryption at rest raises the bar against offline/file-level exposure, not
against code already executing as the daemon.

**Legacy values keep working; no force-migration lockout.** Unprefixed plaintext
values are read as-is. When an encryptor is present, `createConfigStore` also
*opportunistically re-encrypts* any legacy plaintext secrets in place on startup
so they stop sitting in the DB as cleartext — a safe rewrite (the key is held, so
the value stays readable), never a lockout. An upgrade of an existing install
therefore never locks you out of your own config.

## 7. Same-uid agent execution — the env-scrub is hygiene, not a boundary

`agentEnv.ts` strips the daemon-internal variables (above all `SLIPSTREAM_TOKEN`)
from the environment inherited by spawned agent PTYs, and `sessionManager.ts`'
`spawnAgent` runs the scrubbed env. The comments used to imply this *prevented*
worktree code from opening the daemon's WebSocket RPC. That is not true, and the
framing was dangerous, so it is corrected here (FLO-126).

**The agent runs as the same OS uid as the daemon.** A prompt-injected or
malicious agent can:

- `cat <dataDir>/daemon.json` — it holds `{ token, port }` (the data dir is
  `0700`, but owned by that same uid).
- open `ws://127.0.0.1:<port>/rpc` with the recovered token and drive every
  session/repo, or call `getGitHostConfig` (`rpc.ts`) to pull credentials over
  the RPC.
- skip the RPC entirely and read `<dataDir>/slipstream.db` directly for every
  stored git token, the Linear/Jira key, and the raw Firebase service-account
  private key (see §6 — these are plaintext under the daemon / headless
  server).

So the scrub's only real effect is to defeat the most casual drive-by (a process
that happens to `printenv` an inherited token) and to keep the per-session env
clean for the `slipstream` CLI. It does **not** contain a determined agent.

**Why this is MED, not higher.** Slipstream is a single-user tool: pointing an
agent at a repo already means choosing to run that repo's code as your own uid.
The agent reading your config is the same trust decision as the agent running
`rm -rf ~`. What this adds is *breadth* — one prompt injection can exfiltrate
every stored credential and reach across every other session — not a new
privilege boundary being crossed.

**Mitigations:**

- **Sandbox (opt-in, SHIPPED — FLO-146).** See "Opt-in bwrap sandbox" below.
  This is the mitigation that actually closes the hole described above, when
  enabled.
- **Token in daemon memory only.** Pass the daemon's token to its children via
  an inherited fd/pipe instead of persisting `{ token, port }` to
  `daemon.json`. This is partial — it removes the trivial `cat daemon.json`
  path but does nothing about the direct `slipstream.db` read, and it breaks
  daemon reuse across Electron restarts (the parent needs the token to auth to
  an already-running detached daemon). Not shipped.

**Hygiene applied now (FLO-126):** `daemon.json` is created `0600` (was default
`0644`). This changes nothing against a same-uid reader — the `0700` data dir
already gated it — but a file holding a bearer token should not be
world/group-readable as a matter of course.

### Opt-in bwrap sandbox (FLO-146)

Shipped, off by default. Set `SLIPSTREAM_SANDBOX=bwrap` to contain each agent
PTY in a `bubblewrap` mount namespace so a prompt-injected agent can't read
the daemon's data dir. Existing deployments are unaffected unless this is set.

- **Linux-only** (bubblewrap); requires unprivileged user namespaces. When
  `bwrap` is absent, `agentSandbox.ts` logs a one-time warning and runs the
  agent **UNSANDBOXED** — this is a fail-open-for-availability choice, so
  setting the env var is not by itself a hard guarantee; `bwrap` must actually
  be installed and working.
- **Mechanism:** `--dev-bind / /` shares the whole filesystem, then `--tmpfs
  <dataDir>` overmounts the data dir with an empty tmpfs, then only
  `sessions/<sid>` (rw — so the daemon's `fs.watch`-based status sentinel
  still observes writes through the shared host inode), `bin` (ro, the CLI
  wrapper dir), and `clipboard` (ro) are re-bound into it. It does **not**
  change uid — the agent runs as the same OS user as before — it hides the
  data dir from the mount namespace's view, which is what the "no read access
  to the data dir" acceptance requires. `daemon.json`, `slipstream.db`,
  `secret.key`/`secret.salt`, and every other session's directory become
  invisible to the agent.
- **Caveat:** `slipstream open-mr` reads `<dataDir>/slipstream.db` directly to
  resolve the stored git token. Under the sandbox that read is exactly what
  gets blocked, so an agent cannot resolve a token to open a PR/MR itself. A
  daemon-mediated per-session credential handoff (so the token never needs to
  be readable from inside the sandbox) is the follow-up; until then, turning
  the sandbox on trades away agent-initiated `open-mr`.
- The `sessionManager.ts` `defaultSpawnAgent` call site is the sandbox seam
  (see `agentSandbox.ts`'s `sandboxSpawnSpec`) — previously noted above as
  "where it would go," it is now wired in.

## 8. Window pinned to the app origin (FLO-127)

The desktop `BrowserWindow`'s preload (`electron/preload.ts`) deliberately
exposes `window.__slipstreamDaemon = { url, token }` — the daemon WS URL +
bearer token — to the main world so the renderer can bootstrap the WebSocket
connection. `contextIsolation` and `sandbox: true` don't help here: the exposure
is intentional, not a leak through them.

`setWindowOpenHandler` only governs *new* windows (`target=_blank` /
`window.open`, which Slipstream always redirects to the system browser). It does
**not** govern an in-place top-level navigation of the existing window —
renderer-side XSS, a stray `window.location = …`, or a server-side redirect
loads the target origin in the *same* `BrowserWindow`, where the preload re-runs
and hands the credential to that origin.

**Fix (shipped):** the window is pinned to its app origin:

- `main.ts` registers `webContents.on('will-navigate')` and `will-redirect`
  handlers that `preventDefault()` any target off the app origin (the Vite dev
  server in dev, the built `file://…/dist/index.html` in prod). The decision is a
  pure, unit-tested predicate — `isAllowedNavigation(target, appUrl)` in
  `electron/shared/navigationGuard.ts` — same-origin for `http(s)://`, exact path
  for `file://` (whose origin is the opaque `'null'` shared by every local doc),
  deny everything else (`data:`, `blob:`, `javascript:`, custom schemes).
- **Defense in depth:** the preload is also passed `--slipstream-app-url=<url>`
  via `additionalArguments` and gates *both* `__slipstreamDaemon` and
  `__slipstreamNative` on `isAllowedNavigation(location.href, appUrl)`. If a
  navigation ever slipped past the main-process guard (or a subframe ran the
  preload on a foreign document), the credential stays `null` and the renderer
  falls back to web mode rather than leaking. The normal app load always passes
  the check, so desktop behavior is unchanged.

Same-origin SPA route changes are history/hash mutations, not navigations, so a
real `will-navigate` off the origin is never legitimate app behavior — blocking
it cannot regress normal routing.

## 9. Optional Origin allowlist for browser clients (FLO-131)

The `/rpc` WebSocket upgrade authenticates purely by token. Token-gating already
means a cross-site page or a DNS-rebind attacker cannot authenticate, so this is
**defense-in-depth only** — but an optional `Origin` allowlist hardens the
browser attack surface further and lets a disallowed cross-origin connection be
rejected *before* the handshake completes (trimming pre-auth socket churn).

**Config:** `SLIPSTREAM_ALLOWED_ORIGINS` (comma-separated origins, e.g.
`https://host.tailnet.ts.net,http://127.0.0.1:7421`). Unset/empty ⇒ feature off,
every origin accepted (unchanged behavior).

**Semantics** (`originAllowed()` in `server.ts`):

- Enforced **only when a browser sends an `Origin` header**. Header-capable
  clients — the Electron desktop daemon's `Authorization: Bearer` connection and
  the `scripts/e2e/*` drivers — send no `Origin`, so they are never affected.
- A present `Origin` not in the allowlist is rejected with a raw `socket.destroy()`
  **before `handleUpgrade`**. This is deliberately unlike the token path (which
  completes the handshake first to emit a clean `4001` — see §1 and the comment
  at the token check): a cross-origin browser is not a legitimate client that
  needs a distinguishable auth-failure signal, and rejecting pre-handshake avoids
  opening a socket for it at all.
- The `?token=` / `Authorization: Bearer` token check is unchanged and still runs
  after a same-origin (or headerless) upgrade completes.
