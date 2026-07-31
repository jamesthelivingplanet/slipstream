# Security notes

FLO-84. Design notes for auth-adjacent hardening that's either already shipped or
deliberately deferred. See [docs/IDENTITY-SEAM.md](IDENTITY-SEAM.md) for the
per-owner identity model these designs plug into, and
[docs/PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) for the roll-up of which
deployment postures these mitigations gate.

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

## 3. One-time WS ticket endpoint (FLO-144, shipped)

Opt-in — off by default, since only the reverse-proxy-fronted deployment needs
it (see Rollout/scoping below). Set `SLIPSTREAM_WS_TICKETS=1` in
`server.env` to turn it on.

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
   header-capable clients indefinitely.

The `POST /rpc-ticket` handler and the `?ticket=` upgrade branch are always
present in `server.ts` regardless of `SLIPSTREAM_WS_TICKETS` — both are
auth-gated (a ticket can't be minted without a valid bearer token), so leaving
them on costs nothing. The env var only controls whether `/healthz` advertises
`wsTickets: true`, which is what the browser client checks to decide whether
to use tickets at all (see Rollout/scoping). The browser `?token=` path is
**not** retired globally — Electron and Tailscale-web connections still use it
(see below); only reverse-proxy browser clients switch to tickets.

**Leak resistance**: even if a ticket does end up in a proxy access log, it's
already single-use and burns out within ~10 seconds. The replay window for an
attacker scraping logs in near-real-time is negligible, and unlike the static
token, a leaked ticket is worthless the moment it's been used once or has
aged out — there's no persistent credential to rotate.

**Residual — the tokenized onboarding URL.** This fix closes the *recurring*
leak (the WS upgrade credential, resent on every reconnect). It does not touch
`deploy.sh`'s printed onboarding URL (`https://host/?token=...`, for the
operator to open once on a new device) — `main.ts` strips it from the URL bar
client-side via `history.replaceState`, but a reverse proxy in the path has
already logged that one request by then. Behind a reverse proxy, prefer typing
the token into the TokenGate directly over opening the printed URL.

### Client reconnect impact

`wsApi.ts`'s `createWsApi()` takes an optional `ticketUrl`. When set,
`connect()` fetches a **fresh** ticket (`POST` to `ticketUrl`, `Authorization:
Bearer <token>`) before every `new WebSocket(...)` — including every
automatic `scheduleReconnect()` retry — and connects with `?ticket=` instead
of embedding the token in the URL. When `ticketUrl` is unset, `connect()`
stays fully synchronous and uses the legacy `?token=` URL, unchanged.

`main.ts`'s `bootWeb()` (the browser boot path — used by both Tailscale-web
and reverse-proxy-fronted clients) fetches `/healthz` once at boot to learn
`wsTickets`, and only then passes `ticketUrl` into `createWsApi()`.
`bootElectron()` never checks this and never passes `ticketUrl`, so the
desktop app is unaffected regardless of server config.

**4001 means something different in ticket mode.** A WS upgrade closing with
`4001` in token mode means the long-lived token was rejected → `onAuthError`
(clear the stored token, re-show the gate). In ticket mode the token was
already validated at the `POST /rpc-ticket` step; a `4001` on the upgrade
means the *ticket* was bad/expired/used (e.g. a slow client, or the server
restarted and dropped its in-memory ticket map) — not that the token is bad.
`wsApi.ts` treats it as retryable: `scheduleReconnect()` fires and the next
`connect()` fetches a new ticket. A genuinely-bad token only ever surfaces as
a real `401` from `POST /rpc-ticket`, which is the only place `onAuthError`
fires in ticket mode.

### Rollout / scoping

Not every deployment needs this:
- **Electron desktop** talks to a `127.0.0.1` daemon with no reverse proxy in
  the path — nothing logs the URL. Keeps `?token=`.
- **Tailscale HTTPS** (`SLIPSTREAM_SERVE=tailscale`) is an encrypted tunnel
  with no intermediary logging plaintext URLs. Keeps `?token=` too.
- **Reverse-proxy-fronted** (`SLIPSTREAM_SERVE=none` + user-supplied
  Caddy/nginx/Cloudflare Tunnel) is the only case that actually needs tickets.

Gated via `SLIPSTREAM_WS_TICKETS=1` in `server.env` — a dedicated opt-in var
rather than piggybacking on `SLIPSTREAM_SERVE=none`, since that value also
covers a plain fully-local setup with no reverse proxy in front at all (where
tickets would just add a round-trip per reconnect for no benefit). Set it only
when a reverse proxy actually fronts the server.

### Implementation checklist (shipped)

- [x] `POST /rpc-ticket` handler in `server.ts` + in-memory ticket store
      (`electron/server/wsTickets.ts`) + expiry sweeper.
- [x] `?ticket=` branch in the upgrade handler, checked before `?token=`.
- [x] `wsApi.ts`: pre-connect ticket fetch, wired into both the initial
      `connect()` and `scheduleReconnect()`.
- [x] Browser `?token=` path retired for reverse-proxy deployments (gated —
      Electron/Tailscale still use it; see Rollout/scoping).
- [x] Tests: ticket single-use + expiry + identity propagation
      (`electron/server/server.test.ts`), reconnect-refetches-ticket
      (`src/lib/wsApi.test.ts`).

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
  private key (see §6 — these are `sk1:`-encrypted under the daemon / headless
  server post-FLO-145, but the key material that decrypts them — `secret.key`,
  or `SLIPSTREAM_SECRET` sitting in the daemon's process environment — is
  readable by that same uid, so a same-uid agent can still decrypt every one
  of them; the threat stands, just for a different reason than plaintext).

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

**Hygiene applied now (FLO-130):** the data dir is `chmod 0700`'d in the same
process/call that creates it, rather than relying solely on a later `chmod`
that used to run only in the spawned daemon child. On a fresh install this
closes a brief first-boot window where the dir (not the file) sat at default,
umask-dependent perms — a directory-listing/metadata exposure, not a
token-content leak: `daemon.json`'s own `0600` mode (FLO-126, above) already
made the token unreadable by non-owners the instant the file was written,
independent of the directory's mode. The child's chmod in `services.ts` still
runs too, as a backstop for pre-existing installs whose data dir predates
this fix.

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

## 10. Content-Security-Policy on HTML/static responses

`server.ts`'s `DEFAULT_CSP` (applied via the `staticHeaders()` helper to every
static-file/SPA-fallback response — index.html, JS/CSS/font/image assets — but
never to `/healthz`, `/rpc-ticket`, or `/inline-reply`, which are JSON APIs a
browser never renders as a document) is defense-in-depth behind DOMPurify
(`src/lib/markdown.ts` sanitizes agent-transcript markdown before
`ChatView.svelte`'s `{@html}`): if that sanitizer is ever bypassed, `script-src`
blocks the payload from executing anyway.

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' ws: wss:;
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none'
```

- **`script-src 'self'` only** — no `'unsafe-inline'`/`'unsafe-eval'`. This is
  the directive that actually matters for XSS; the Vite build emits only
  external `<script type=module src=...>` tags, no inline script.
- **`style-src` allows `'unsafe-inline'`** — a deliberate, documented
  trade-off, not an oversight. Svelte's scoped styles and Tailwind's arbitrary
  values land as inline `style=` attributes, and xterm.js's `DomRenderer`
  injects a `<style>` element at runtime with no CSP nonce plumbed through — a
  nonce-based policy would need xterm patched to accept one. Inline *style*
  injection can't execute script, so the risk this trades away is limited to
  CSS-based data exfiltration/spoofing, not XSS.
- **`img-src`** adds `data:` (QR pairing codes via the `qrcode` package) and
  `blob:` (chat image-attachment previews via `URL.createObjectURL`).
- **`connect-src`** adds `ws:`/`wss:` explicitly alongside `'self'` for the
  same-origin `/rpc` WebSocket — CSP3 already maps `'self'` across the
  http↔ws scheme pair, but spelling it out removes any doubt for older
  engines.
- **`worker-src 'self'`** covers the push-notification service worker
  (`public/sw.js`), whose own same-origin `fetch('/inline-reply')` is already
  covered by `connect-src 'self'`.
- **`object-src`/`base-uri`/`frame-ancestors` are locked to `'none'`** — the
  app embeds no plugins, needs no `<base>` rewriting, and is never framed.

**Escape hatch:** `ServerOptions.csp` accepts `false` to omit the header
entirely, for a deployment whose front door (or a browser quirk) trips over
the default policy — mirroring `SLIPSTREAM_ALLOWED_ORIGINS`/
`SLIPSTREAM_WS_TICKETS` above, this is a config knob, not a code change.

## 11. Biometric gate on the mobile app's stored token (FLO-159)

**Threat.** The Android app's saved bearer token (`TOKEN_KEY`, Keystore-backed
via `@aparajita/capacitor-secure-storage`) is a live credential for the
user's whole daemon — anyone who can open the app can drive every session
and repo, and pull whatever `getGitHostConfig` exposes. Before this, the
only thing standing between an unlocked, handed-over (or lost/stolen and
unlocked) phone and that token was the OS's own app/device lock: once past
that, the SPA read the token straight out of storage and connected.

**Mitigation.** Opt-in, off by default — `Settings > Security` (native shell
only) exposes a "Require fingerprint to unlock" toggle. Turning it on
requires first passing a real `BiometricPrompt`
(`SettingsSecurity.svelte`'s `handleEnable()`); only a successful prompt
persists the preference, so a user can't arm a gate they can't themselves
pass and lock themselves out of their own saved token. `AppControlPlugin`'s
`biometricAuthenticate()` requests `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`
(falling back through `BIOMETRIC_WEAK | DEVICE_CREDENTIAL`, then plain
`BIOMETRIC_STRONG`, on API 28/29 where the combined check is unsupported —
see `resolveAuthenticators()` in `AppControlPlugin.java`) — device PIN is
deliberately allowed as a fallback authenticator so a device with no
enrolled fingerprint still has a way to unlock, rather than the toggle
being unusable or the user getting locked out.

The gate is enforced where the token is **read**, not just at boot:
`nativeStorage.ts`'s `get(TOKEN_KEY)` returns `null` while `locked` is true,
independent of which caller asked (`src/main.ts`'s boot sequence and
`SettingsIntegrations.svelte`'s pairing-link section both go through this
same `get()`). That is a deliberate design choice over gating only the
app-open path: Android keeps the Capacitor WebView alive across
backgrounding rather than reloading it, so a boot-only gate would only ever
fire on a cold start — background the app and switch back and the token
would just sit there unlocked for as long as the process survives. The
resume re-lock (`installResumeRelock()`, a `visibilitychange` listener)
closes that gap: past `RELOCK_GRACE_MS` (60s) of actual hidden time, the
next resume re-locks the token, and `App.svelte` throws the `BiometricGate`
overlay up over the already-mounted app. The short grace window is
deliberate too — switching away to the fingerprint prompt itself, or to the
OS share sheet/clipboard and straight back, must not immediately re-trigger
the gate.

A "Sign out" escape hatch on the lock screen (`BiometricGate.svelte`'s
`onSignOut`, wired in both `main.ts`'s boot gate and `App.svelte`'s resume
overlay) clears the stored token, drops the FLO-151 reply-credential stash,
and disables the lock preference. Without it, a failed or abandoned
fingerprint (no enrollment left, hardware fault, lockout after too many bad
attempts) would strand the user behind a gate with no way back in short of
reinstalling.

**Residual gaps — stated plainly, not closed:**

- **The FLO-151 `ReplyPrefs` stash is deliberately NOT behind this gate.**
  `ReplyPrefs.java` keeps its own copy of the daemon URL + token in
  app-private (`MODE_PRIVATE`) `SharedPreferences` so the background
  `ReplyReceiver` can POST `/inline-reply` from a `RemoteInput` action while
  the app process is dead — a case where there is no running WebView to
  show a biometric prompt from at all. This copy is unreachable by this
  gate's threat actor (someone holding the unlocked phone, without root or
  a debug-enabled build — same-uid reads of app-private storage are a
  different, already-documented threat, see §6/§7), and gating it would
  simply break background inline reply rather than add real protection.
  `ReplyPrefs.java`'s own doc comment already flags the plaintext-at-rest
  trade-off this implies; this gate does not change that calculus either
  way.
- **This is a UI-level gate on a token that stays decryptable by the app
  process, not a KeyStore-bound key that itself requires biometric auth to
  unwrap.** `unlockToken()` flips an in-memory `locked` flag after a
  successful prompt; the underlying secure-storage value was never sealed
  behind the biometric result in the way, say, a `BIOMETRIC_STRONG`-bound
  Android Keystore key would be. It raises the bar against someone picking
  up an unlocked phone and casually opening the app, but it does **not**
  defend against a rooted device or physical extraction of the Keystore
  blob — an attacker with that level of access reads the token the same way
  they would without this feature.
- **Opt-in and off by default.** Existing installs are unaffected until a
  user turns the toggle on themselves.

**Why there's no equivalent on web/PWA/Electron.** This gate is built on
the Capacitor `AppControl` plugin's `BiometricPrompt` bridge, which only
exists inside the native Android shell (`biometric.ts`'s
`biometricPluginAvailable()` is `false` everywhere else, mirroring every
other `window.Capacitor`-gated bridge in this codebase). A plain browser
tab, the installed PWA, and the Electron desktop have no such bridge to
call, and their stored-token exposure is a different shape entirely: the
Electron desktop pins its window to the app origin and never leaves
`127.0.0.1` (§8), and a browser client's token is scoped to that browser's
own storage/session, protected by the OS session lock and the CSP/origin
hardening in §9–§10 rather than by an in-app prompt.

## 12. Home-screen widget Stop/Restart — app-mediated actions, not a widget credential (FLO-162)

**Threat.** TASK-DM25C's home-screen widget (`AgentWidgetService`,
`AgentWidgetProvider`) renders session rows from a JSON snapshot
(`WidgetPrefs.SESSIONS_JSON_KEY`) written by `syncWidget()` — a
`RemoteViewsService` with no auth token and no network access on its render
path, by original design. FLO-162 was filed flagged "needs deliberate
re-architecture" specifically because adding Stop/Restart buttons the naive
way — a `BroadcastReceiver` that calls the daemon directly off a widget tap —
would have to route the bearer token onto that path: either baked into the
widget process's own storage (a new, permanently-resident credential copy
outside the FLO-159 gate above) or read out of `nativeStorage` from a
headless receiver with no running WebView and no way to ask the user
anything first.

**Mitigation — app-mediated actions.** The widget records *intent*, never a
credential. A Stop/Restart tap on a row fills in an `action` extra
(`"open"` | `"stop"` | `"restart"`) alongside the existing `sessionId` on
the row's `PendingIntent` template (`AgentWidgetService.getViewAt`),
launches the app, and `MainActivity.stashWidgetAction()` writes
`{ action, sessionId, pendingAt }` into app-private
(`MODE_PRIVATE`) `SharedPreferences` (`WidgetPrefs.PENDING_ACTION_KEY` /
`PENDING_SESSION_ID_KEY` / `PENDING_AT_KEY`) — never into anything the
widget's own `RemoteViewsService` process reads back. The SPA — which holds
the daemon token behind the §11 biometric gate the whole time — is the only
thing that ever turns that intent into a real RPC, via
`AppControlPlugin.consumePendingWidgetAction()` (native) and
`consumePendingWidgetActionAndExecute()` (`src/lib/widgetSync.ts`), polled
on cold start, on `visibilitychange` resume, and right after a successful
biometric unlock so an action tapped while locked still runs instead of
being silently dropped. The widget's render path — `syncWidget()`, the
JSON snapshot, `SESSIONS_JSON_KEY`/`UPDATED_AT_KEY` — is unchanged by any
of this: it stays exactly as token-free as it was before FLO-162.

Two properties do the load-bearing work:

- **Read-and-clear, TTL-bounded.** `consumePendingWidgetAction()` clears
  `WidgetPrefs`'s pending-action trio *before* resolving, so a stash is
  consumed at most once even if the SPA's boot-time and resume-time checks
  race each other — a tap can't fire twice. `PENDING_AT_KEY` bounds how
  long a stash stays live (`PENDING_TTL_MS`, 2 minutes); past that it
  resolves as `{}` (nothing pending) rather than firing, so a tap that sat
  unconsumed because the app was killed, or the user got distracted before
  unlocking, can never act on a session's state long after the user meant
  it — the 2-minute window is short enough that "the session I'm about to
  stop is the session I tapped" stays true.
- **`'stop'` requires an in-app confirm; `'restart'` doesn't need one.**
  This is architectural, not cosmetic. `resumeSession(id)` (what
  `'restart'` maps to) is a single recoverable RPC — safe to fire
  unconfirmed. `'stop'` maps to `cleanupAgent()`, which kills the session
  and then cleans up the worktree; on a dirty worktree that raises a
  "force-removing discards any uncommitted changes and unmerged commits"
  prompt (`confirmDialog`) that only the SPA, running with a live UI, can
  show. A `BroadcastReceiver` acting on a widget tap directly has no UI to
  ask that from — it would have to either silently force-destroy unpushed
  agent work or leave a session half torn down. That's the concrete reason
  Stop can't be backgrounded into the receiver, independent of the token
  question: `consumePendingWidgetActionAndExecute()`'s `'stop'` branch
  always raises `confirmDialog` before calling `cleanupAgent()`, and there
  is no code path that skips it.

**Governing precedent.** The house pattern for "an edge actor needs a
privileged effect" is already established by the `slipstream` CLI
(`electron/cli/slipstream.ts`): its header states identity is scoped to the
session env and "no daemon token is ever exposed to the agent" — the agent
causes privileged effects by writing sentinel files the daemon watches
(`status.json`/`outcome.json`/`pr.json`), and even `open-mr` (the one
command that needs a git token) resolves it inside the CLI process on the
daemon host rather than handing it to the agent. The widget now follows the
same inversion: the edge (agent PTY / widget tap) expresses intent, the
privileged side (daemon / SPA holding the gated token) holds the credential
and decides. The mechanism doesn't transfer literally — the CLI's
sentinel-file channel assumes a filesystem shared with the daemon, and a
phone has none — but the inversion (never hand the credential to the actor
that only needs to *ask*) does.

**Rejected alternatives.**

- **Reusing the FLO-151 `ReplyPrefs` stash in a widget click receiver.**
  Cheapest to build — `ReplyPrefs.java` already keeps a plaintext
  daemon-URL-plus-token copy in `MODE_PRIVATE` `SharedPreferences` for the
  background inline-reply receiver (see §11's residual-gaps list). Rejected
  because it would extend a stash its own doc comment already calls
  prototype-grade from covering one notification action to being the
  permanent backing for home-screen buttons the user can tap any time —
  outside the §11 biometric gate entirely — and it still can't render the
  force-remove confirm a headless receiver has no UI for, so Stop would
  still be compromised even with a token available.
- **Short-lived, single-use, session+action-scoped grants** — generalizing
  the FLO-144 one-time WS ticket pattern (§3) to widget actions, so a tap
  could act with no app launch at all. This is the only rejected design
  that would deliver true no-launch actions, but it needs: a new minting
  endpoint, a grant lifecycle (issuance/expiry/rotation, not just the
  10-second single-shot TTL §3's tickets use), a new credential class
  scoped through the `ownerId` identity seam (docs/IDENTITY-SEAM.md) rather
  than reusing an existing one, and a second at-rest credential stash on
  the device to hold the minted grant between mints. It *still* leaves
  Stop compromised — a grant is a credential, and a headless receiver
  redeeming one still can't show the force-remove confirm. Revisit this
  only once **both**: (1) a per-action confirm-or-not policy exists so
  `'stop'` can be excluded from no-launch grants (or the confirm itself is
  redesigned to not require a foreground app), and (2) the grant-lifecycle
  and second-stash cost is justified by a concrete complaint about the
  accepted cost below, not preemptively.

**Accepted cost, stated plainly.** Every widget action costs a foreground
app launch plus, if the §11 gate is armed, a biometric unlock. It is not a
one-tap background action the way the FLO-151 inline-reply button is. That
is the deliberate price of keeping the token inside the gated SPA process
and off the widget's render and click paths.

**Residual gaps — stated plainly, not closed:**

- **The FLO-151 `ReplyPrefs` stash (§11's residual-gaps list) is unchanged
  by this work.** It remains a plaintext, ungated token copy for a
  different feature (background inline reply); FLO-162 did not extend it
  and did not close it.
- **A killed app still costs a real cold start**, not just an unlock —
  `stashWidgetAction()` writes to `SharedPreferences` regardless of
  whether the app is running, but nothing consumes the stash until the SPA
  boots and reaches the post-backend-load `consumePendingWidgetActionAndExecute()`
  call, so the 2-minute TTL is a real constraint on a slow cold start, not
  just a theoretical one.
- **No server-side record that an action originated from the widget.** The
  RPC the SPA ends up issuing (`resumeSession`/`cleanupAgent`) is
  indistinguishable, once made, from the same action triggered from the
  sidebar — this is intentional (the widget is a trigger, never a
  separately-audited actor) but means widget-originated actions aren't
  separately logged or rate-limited.

A latent, unrelated bug surfaced and was fixed as a side effect of this
work: the widget row's plain-tap deep link (open the app to a specific
session) was dead before FLO-162. `MainActivity` used to dispatch a
`slipstream:widget-open` DOM `CustomEvent` via `evaluateJavascript()` that
nothing in the SPA listened for, and on a cold start the event fired before
the page had loaded regardless. `subscribeWidgetAgentOpen()`
(`src/lib/widgetSync.ts`) binds a Capacitor `'openAgent'` listener that no
native code ever emitted — two halves that never met. The new
`stashWidgetAction()`/`consumePendingWidgetActionAndExecute()` pair (an
`'open'` action is the default when a widget-built-before-FLO-162 omits the
`action` extra) replaced the dead `evaluateJavascript` dispatch and made
row-tap deep-linking work for the first time.
`subscribeWidgetAgentOpen()` itself was deliberately left in place — its
Capacitor 6-vs-7 dual-shape handling is separately tested — but it is still
unfired by any native code path; don't mistake it for a live channel.

## 13. Self-service device pairing codes

**What this is.** docs/IDENTITY-SEAM.md's open item 2: before this, minting a
second device's credential required an operator to run `pnpm tokens -- issue
<ownerId> <label>` and hand the printed token to the new device out of band
(docs/PRODUCTION-READINESS.md §1 rung 4's gate). This adds a self-service
path: a user who is already authenticated on one device can onboard a second
device of their own without an operator in the loop.

**The governing precedent, and why this is the deliberate exception to it.**
The house pattern for "an edge actor needs a privileged effect" — established
by the `slipstream` CLI (§12 above) and the FLO-162 widget — is to never hand
the credential to the actor that only needs to *ask*: the edge expresses
intent over a channel the privileged side watches, and the privileged side
decides. Device pairing does not follow that pattern, and it can't: its
entire purpose is to deliver a real, usable credential to a device that
currently has none. There is no "intent, not credential" version of "give
this phone a bearer token." That's exactly why the constraints below are as
tight as they are — this is the one flow in the codebase that is allowed to
hand out a credential over the network, so it has to earn that trust deliberately
rather than by default.

**The flow.**

1. **`createPairingCode()`** — an authenticated, owner-scoped RPC
   (`electron/core/rpcHandlers/pairing.ts`). Mints a short-lived, single-use
   code bound to the CALLER's identity, as resolved by the existing
   `RpcContext` seam (docs/IDENTITY-SEAM.md) — never to a client-supplied
   `ownerId`. Returns `{ code, expiresAt }`. Surfaced in Settings → Security
   as "Pair a device", which shows the code, a countdown to expiry, and (since
   the `qrcode` package is already a dependency, used by the existing
   token-pairing-link QR in `SettingsIntegrations.svelte`) a QR code.
2. **`POST /pair`** (`electron/server/server.ts`) — the ONLY genuinely
   unauthenticated endpoint in the server, because a brand-new device has no
   credential yet and therefore cannot use the `Authorization`/`?token=`
   paths every other endpoint (including `/rpc-ticket` and `/inline-reply`,
   §3/§11-adjacent) relies on. Body: `{ code }`. On success, redeems the code
   against `electron/services/devicePairing.ts`'s in-memory store and mints a
   real device token via the existing `deviceTokenStore.issue(ownerId,
   label)` path (§4) — returned exactly once, then the code is burned.

**Defenses on the new unauthenticated surface** (`electron/services/devicePairing.ts`):

- **Hashed at rest.** Only the SHA-256 hash of a code is ever held in memory
  (`hashCode`, mirroring `deviceTokenStore.ts`'s `hashToken`) — a heap dump
  doesn't hand out a usable code, and if this store were ever backed by
  persistence later, neither would a stolen DB.
- **Single-use, redeemed atomically.** Redemption marks a code `used` as the
  very next synchronous statement after the lookup, with no `await` in
  between — Node never preempts mid-handler, so two devices racing the same
  code (e.g. two tabs both submitting a pasted code) cannot both win; exactly
  one gets a token. Covered by a concurrent-double-redeem test in
  `devicePairing.test.ts` and an end-to-end version (`Promise.all` of two
  `POST /pair` calls) in `server.test.ts`.
- **Short TTL — 5 minutes.** A code only needs to survive the walk from
  looking at one screen to keying/scanning it into another, not a session
  lifetime.
- **Entropy vs. the rate limit, stated plainly.** Each code is 16 random
  bytes (128 bits), base64url-encoded — the same generation shape as
  `deviceTokenStore`'s token and the §3 WS ticket. `POST /pair` is
  rate-limited to 10 attempts per 60s **per source IP**
  (`createPairRateLimiter`), so across a code's whole 5-minute TTL any one IP
  gets at most ~50 guesses. Against a keyspace of 2^128 (~3.4e38), the odds of
  a correct guess in 50 attempts are on the order of 50 / 3.4e38 — brute force
  is not a realistic threat here, and an attacker would need to spread guesses
  across many independently-capped IPs just to reach that many attempts.
- **Constant-time comparison.** Redemption hashes the presented code first
  (converting "does a raw secret comparison leak length/prefix via timing"
  into "does a fixed-length digest comparison leak anything," which SHA-256's
  preimage resistance forecloses) and then compares against every live
  entry's hash with `crypto.timingSafeEqual`, rather than a plain `Map` key
  lookup that would rely on V8's internal string equality.
- **One uniform error.** A wrong code, an expired code, an already-used code,
  an unknown code, and even a deployment with no pairing store wired up at
  all — every one of these returns the identical `401 {"error": "Invalid or
  expired code"}`. This mirrors the WS upgrade's `4001`-for-any-reason
  convention (§1) and `/inline-reply`'s identical-404-for-missing-or-other-owner
  convention (§4/IDENTITY-SEAM.md's no-existence-leak rule): a network
  observer, or the calling device itself, can never learn which case
  occurred. (A structurally malformed request — no `code` field at all,
  invalid JSON — gets its own distinct 400; that's a client bug, not a guess
  among the code's keyspace, so it doesn't need to be folded into the uniform
  case.)
- **No enumeration.** There is no GET/list variant of `/pair` and no
  unauthenticated way to ask "are any codes currently live" — a code can only
  ever be redeemed, never listed or probed for existence short of guessing it
  outright (covered by the entropy/rate-limit math above).

**Interaction with §2's reverse-proxy-logs-the-URL threat.** The code
travels in the `POST /pair` request **body**, never a query string — exactly
the lesson §2/§3 already established for the WS token. The Settings → Security
QR encodes the code as a URL **fragment** (`#pair=<code>`), not a query
string either: a fragment is never sent in the HTTP request, not even for the
very first page load, so — unlike the existing token-pairing-link QR in
`SettingsIntegrations.svelte` (which embeds `?token=` and has a documented
residual gap in §3 for exactly this reason) — this QR's deep link cannot land
in a reverse-proxy access log at any point in the flow. `TokenGate.svelte`
reads `location.hash` once on mount, prefills the code field, and immediately
strips the fragment via `history.replaceState` so it doesn't linger even in
local browser history beyond that instant.

**What this does NOT close.** This is self-service onboarding for docs/IDENTITY-SEAM.md's
item 2 and softens docs/PRODUCTION-READINESS.md §1 rung 4's operator-CLI gate —
it is not a step toward rung 5 ("Public / untrusted multi-tenant"). Rung 5 is
explicitly gated on per-owner integration config, the per-owner-data-dir
decision, a real privilege boundary for agent execution, and rate/abuse/quota
controls between owners — none of which this flow touches. A pairing code is
scoped to the identity that minted it (same single/multi-user posture as
every other device token, §4) and does nothing to isolate owners from each
other once both are provisioned. `pnpm tokens -- issue` (§4) is unchanged and
still the only path for an *operator* to mint a credential for someone who
isn't already an authenticated user of the deployment — pairing codes only
help an existing, authenticated owner add another device of their own.
