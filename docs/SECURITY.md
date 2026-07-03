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

## 4. Single static token, no revocation granularity

Today one token authenticates every device, forever. Rotating it means editing
`server.env` and re-onboarding every device that holds the old value — there's
no way to revoke a single compromised device's access without also breaking
every other device. This is an acceptable trade for the single-user tier; it's
the first thing that needs to change for a multi-user tier, and the
`resolveIdentity` seam in `electron/core/auth.ts` (see IDENTITY-SEAM.md) is
already positioned so that a per-device/per-user token store slots in without
touching any downstream call site.

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
