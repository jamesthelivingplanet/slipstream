# Production readiness (FLO-142)

FLO-142 is the tracking issue for "is Slipstream production ready" — this doc is its
roll-up. The short answer is that "production ready" isn't a single yes/no: it's only
meaningful against a **named posture** (who's running it, who's reaching it, over what
network). Section 1 lays out the postures Slipstream supports today and what each wider
one is gated on. Section 2 is the status of the five hardening sub-issues FLO-142 tracked
individually. Section 3 is the explicit go/no-go checklist for declaring a production cut
— split into what a command can check and what requires a judgement call, because the
ticket's own scope-stability sub-issue asked for exactly that split rather than an
implicit "it feels done." Section 4 covers `pnpm readiness`, the command that checks
which of this hardening is actually *active* on a given host.

## 1. Posture ladder

Each rung requires everything below it, plus what's listed. "Supported" means the code
and docs exist and the residual gaps are known and stated (see §2) — not that the rung
has zero risk.

### 1. Single-owner desktop / `127.0.0.1` daemon

**Supported, no extra config.** The Electron app spawns a local daemon bound to
`127.0.0.1`; nothing on the network can reach it. This is the default `pnpm dev` /
installed-desktop-app posture.

### 2. Single-owner remote over Tailscale HTTPS (`SLIPSTREAM_SERVE=tailscale`)

**Supported.** `pnpm deploy` runs `tailscale serve --https=443`, publishing the daemon at
`https://<host>.<tailnet>.ts.net/`. Tailscale HTTPS is an encrypted tunnel with no
intermediary that logs the URL, so the browser client's `?token=`-in-the-WS-URL scheme
(the only option a plain `new WebSocket(url)` call has — browsers can't set custom
headers on an upgrade request) is fine here. See docs/SECURITY.md §1–§2.

### 3. Single-owner behind a self-supplied reverse proxy (`SLIPSTREAM_SERVE=none` + Caddy/nginx/Cloudflare Tunnel)

**Supported, ONLY with `SLIPSTREAM_WS_TICKETS=1`.** The moment a reverse proxy sits in
front of the daemon, its access log records the full WS upgrade URL — including
`?token=` — on every connect and every automatic reconnect. `SLIPSTREAM_WS_TICKETS=1`
(FLO-144, docs/SECURITY.md §3) swaps that for a single-use, ~10s-TTL ticket fetched over
a header, closing the recurring leak. It does **not** touch the one-time onboarding URL
`deploy.sh` prints (`https://host/?token=...`) — that's a single request, already logged
by the proxy before the client ever strips it from the URL bar. Behind a reverse proxy,
prefer typing the token into the TokenGate directly over opening the printed URL.

### 4. Multi-device / multi-owner self-host, operator-provisioned

**Supported, with caveats.** `pnpm tokens -- issue <ownerId> <label>` (FLO-143,
docs/SECURITY.md §4, docs/IDENTITY-SEAM.md) mints per-device, individually-revocable
credentials, and every RPC is owner-scoped (`ownerId` filtering in `electron/core/rpc.ts`
— see docs/IDENTITY-SEAM.md's Enforcement section). But:

- Onboarding is manual — an operator runs the CLI and hands the printed token to the new
  device; there's no self-service RPC/UI, no QR-code flow the way the single static
  `SLIPSTREAM_TOKEN` has.
- The `config` table (Linear/Jira credentials, git tokens, editor command, GC policy) is
  deployment-global, not per-owner — every owner on the deployment shares one set of
  integration credentials (docs/IDENTITY-SEAM.md "What's still open" item 6).
- Isolation is row-level `ownerId` scoping only; there's no per-owner data directory
  (docs/IDENTITY-SEAM.md item 5, still open).

This rung is appropriate for people who **already trust each other and the operator** —
a household, a small team sharing one deployment where "another owner's Linear key is
visible to the config store" is an acceptable trust boundary. It is not appropriate for
mutually-untrusting owners.

### 5. Public / untrusted multi-tenant

**Not supported.** This is gated on things that don't exist yet, not on hardening a
config flag would turn on:

- Per-owner integration config (the config-table-is-global gap above), so one owner's
  credentials are never visible to another's requests.
- The per-owner-data-dir vs. row-level-isolation decision (docs/IDENTITY-SEAM.md item 5)
  — resolved one way or the other, deliberately, not left implicit.
- Self-service onboarding (docs/IDENTITY-SEAM.md item 2).
- A real privilege boundary for agent execution. The bwrap sandbox (docs/SECURITY.md §7)
  is filesystem-only and does not change uid — it is not a substitute for a separate uid
  or a VM, and untrusted multi-tenant needs one of those.
- Things nobody has built at all: rate limiting, abuse controls, and quota/cost isolation
  between owners (an agent under one owner's session can consume API cost and compute
  with no ceiling tied to that owner).

This rung is not "one more sprint on top of rung 4" — it's a different product, with a
different threat model (untrusted tenants instead of trusting co-users) and a different
set of things that must exist before the first untrusted user connects.

| Rung | Posture | Status | Gate |
|---|---|---|---|
| 1 | Desktop / `127.0.0.1` | Supported | none |
| 2 | Remote, Tailscale HTTPS | Supported | none (encrypted tunnel) |
| 3 | Remote, self-supplied reverse proxy | Supported | `SLIPSTREAM_WS_TICKETS=1` |
| 4 | Multi-device, operator-provisioned | Supported, with caveats | `pnpm tokens`; shared config; row-level isolation only |
| 5 | Public / untrusted multi-tenant | Not supported | per-owner config, data-dir decision, onboarding, real privilege boundary, rate/abuse/quota controls |

## 2. Blocker status

All five FLO-142 sub-issues that target concrete hardening are shipped on master. Each
has a real residual gap — stated here rather than glossed over, per the ticket's own
standard for what "shipped" means.

| Blocker | Issue | State | Documented in | Residual gap |
|---|---|---|---|---|
| Multi-user token store | FLO-143 | Shipped | docs/SECURITY.md §4, docs/IDENTITY-SEAM.md | Device tokens exist and are individually revocable, but there's no self-service onboarding UX, and the `config` table is deployment-global — distinct owners share one set of Linear/Jira/git credentials. Isolation is row-level `ownerId` only; the per-owner-data-dir decision is still open. |
| One-time WS ticket endpoint | FLO-144 | Shipped | docs/SECURITY.md §3 | Opt-in (`SLIPSTREAM_WS_TICKETS=1`), off by default. The residual tokenized onboarding URL printed by `deploy.sh` is untouched — it's a single logged request, not the recurring reconnect leak this fix closes. |
| Secrets encrypted at rest (daemon/headless) | FLO-145 | Shipped | docs/SECURITY.md §6 | The file-backed key fallback (`secret.key`, used when `SLIPSTREAM_SECRET` is unset) does not survive theft of the whole data dir — the key sits right next to the DB it protects. Neither key-sourcing mode defends against a same-uid reader: a process running as the daemon's own uid can read the key and the DB alike. |
| Opt-in bwrap agent sandbox | FLO-146 | Shipped | docs/SECURITY.md §7 | Filesystem-only containment — does not change uid. Off by default (must set `SLIPSTREAM_SANDBOX=bwrap`). **Fails open**: if `bwrap` isn't on PATH, `agentSandbox.ts` logs a one-time warning and runs the agent **unsandboxed** rather than refusing to start. Turning it on trades away agent-initiated `slipstream open-mr`, which reads `slipstream.db` directly for the stored git token — exactly the read the sandbox blocks. |
| Versioning + release scheme | FLO-147 | Shipped | docs/VERSIONING.md | None material — semver, `pnpm release`, and `/healthz` version/gitSha/schema reporting are all in place and exercised by the release flow itself. |

**FLO-57 (Podman pod-deploy path unverified)** is tracked separately from FLO-142's five
named sub-issues and is minor: the Docker Compose pod-deploy path (docs/POD-DEPLOY.md) is
verified only on Docker. Podman needs volume-ownership (`:U`), `network_mode:
service:tailscale` translation, and rootless-networking tweaks before the same one-command
path works there — see docs/POD-DEPLOY.md's Podman section. It does not block any posture
above, since Docker remains the supported path for rung 3/4 self-hosting.

**The sixth, unresolved sub-issue is scope stability, not a hardening gap** — quoted from
the ticket: "Core UX is still actively finding its shape (Night Ops parity, chat interface
for opencode/pi, chat-by-default). This isn't frozen — factor that in when deciding when to
declare a production cut." That's a product-scope question, not something a check script
can answer, which is why it gets its own class of gate below rather than being folded into
the mechanical ones.

## 3. Go/no-go criteria for a production cut

Two classes of gate, deliberately kept separate:

- **Mechanical gates** are checkable — ideally by running a command — and either pass or
  they don't. There's no judgement call involved.
- **Scope-stability gates** are judgement calls that must be made *explicitly*, because the
  failure mode the ticket called out is exactly the opposite: declaring a cut "done" by
  vibes, with UX still visibly in flux underneath it.

Treating both classes as if they were the first (checking the mechanical gates and calling
it done) is what "it feels done" looks like from the inside. The split forces the second
class to be a real decision with a real answer, not a default.

### Mechanical gates

- `pnpm readiness` reports no `fail` against the target posture (see §1 and §4). Which
  checks actually matter depends on the rung being cut for:
  - Rung 3 (reverse-proxy) needs `ws-tickets` at `pass`, not `warn`.
  - Any rung that runs untrusted agent input wants `agent-sandbox` at `pass` — a `warn`
    (sandbox off) or, worse, a silent fail-open (`bwrap` requested but missing) is not
    acceptable for that case; `pnpm readiness` reports the fail-open case as a hard
    `fail` specifically so it can't be missed.
  - Rung 4 wants `auth-token` and `secrets-at-rest` at `pass`, and an operator who has
    actually run `pnpm tokens -- issue` for each distinct owner (the `multi-user` check
    is `info`-only — it cannot see inside the DB, see §4).
- `pnpm check` (svelte-check), `pnpm test`, and `pnpm lint` are all green.
- The cut is tagged and changelogged via `pnpm release` (docs/VERSIONING.md) — not a bare
  git tag. This is what keeps `/healthz`'s version/gitSha/schema meaningful and the
  CHANGELOG's `[Unreleased]` section rolled into a dated entry.
- `/healthz` on the actually-deployed host reports the expected `version`/`gitSha`/`schema`
  — i.e. the deploy that ran actually landed, not just that a release was tagged.
- DB migrations apply forward cleanly on a copy of a real data dir (not just a fresh empty
  DB) — `electron/db/migrations.ts`'s `MIGRATIONS` array is additive-only, but "additive in
  the code" and "actually applies to a data dir that's been through several prior versions"
  are different claims; verify the second one on a copy before cutting.

### Scope-stability gates

- Night Ops parity, the chat interface for opencode/pi, and chat-by-default must each be
  either shipped-and-stable or **explicitly** declared out of the cut and deferred. The
  failure mode this guards against is an implicit "it feels done" — silence on one of these
  is not the same as a decision to exclude it.
- **Contract-churn signal**: `electron/shared/contract.ts` and `electron/shared/wire.ts` are
  where breaking changes show up (see docs/VERSIONING.md's MAJOR-bump definition). A cut
  wants a recent stretch with no breaking edits to either file — a MAJOR version bump means
  a coordinated desktop+daemon upgrade, which is exactly the kind of forced-migration event
  you don't want landing on users right after declaring "production ready."
- No open security item rated MED or higher without a documented mitigation. (docs/SECURITY.md
  §7 is the current MED-rated item — same-uid agent execution — and its mitigation, the
  opt-in sandbox, is documented there along with its own residual gap; that's the bar every
  other open item needs to clear too.)

### Decision rule

Declare the cut against a **named rung** from §1, record which gates were waived and why,
and do not widen the posture afterward without re-running the gates for the new rung — a
cut declared for rung 2 does not carry over to rung 4 just because nothing crashed.

## 4. How to check the live posture

`pnpm readiness` (`scripts/readiness.mjs`, pure evaluator in `scripts/lib/readiness.mjs`)
inspects a deployment and reports, gate by gate, whether this hardening is actually
**active** — a different question from whether it's shipped in the codebase (§2 answers
the shipped question; this answers the active-on-this-host question).

- **Inputs**: `~/.config/slipstream/server.env`, the data dir (existence + permission bits
  on the dir itself and on `daemon.json`), and whether `bwrap` is on `PATH`.
- **Nine checks**, each printed as one line with a status and a doc pointer: `auth-token`,
  `ws-tickets`, `secrets-at-rest`, `agent-sandbox`, `origin-allowlist`, `data-dir-perms`,
  `daemon-json-perms`, `version-stamp`, `multi-user`.
- **Status is posture-dependent for `warn`, not for `fail`.** A `warn` on `ws-tickets` is
  expected and fine on a Tailscale-only deployment (rung 2) — nothing is wrong. A `fail`
  is never posture-dependent: it means something is broken or actively misleading
  regardless of which rung you're running, above all the `agent-sandbox` fail-open case
  (`SLIPSTREAM_SANDBOX=bwrap` set, `bwrap` missing from PATH) — the whole reason this
  check exists is that grepping the codebase for "is the sandbox shipped" can't tell you
  it's silently not engaging on this particular host.
- `--json` emits the same data as structured output (plus `dataDir` and `shadowed`, see
  below). **Exit code is a triple, not a boolean**: `0` — no check is `fail`; `1` — at
  least one check is `fail`; `2` — the run is **inconclusive** (sandbox-shadowed, next
  bullet), regardless of what the individual check statuses say. Wire it into a deploy
  gate the same way `pnpm check`/`pnpm test`/`pnpm lint` already gate `pnpm release`
  (docs/VERSIONING.md) — treat *any non-zero* exit as "not a clean bill of health," since
  `2` must never be collapsed into `0`.
- It **deliberately cannot see inside the DB** — the `multi-user` check is `info`-only for
  exactly this reason. Device-token state (how many owners, which are revoked) comes from
  `pnpm tokens -- list`, not from `pnpm readiness`.
- **Running it from inside an agent PTY reports on a tmpfs, not the host.** A session
  spawned under `SLIPSTREAM_SANDBOX=bwrap` gets its data dir overmounted with an empty,
  private tmpfs — only `sessions/<sid>`, `bin` and `clipboard` are re-bound back in (see
  `electron/services/agentSandbox.ts`, docs/SECURITY.md §7). `server.env`, `daemon.json`,
  `secret.key` and the directory's real permission bits are all invisible from inside
  that PTY, so a naive run would read the tmpfs's own (wrong) state and confidently print
  fabricated FAILs — `auth-token` for a token that is actually set, `data-dir-perms` for a
  mode that isn't the host's. `pnpm readiness` detects this instead of trusting what it
  sees: when it's running inside an agent PTY (`SLIPSTREAM_SESSION_ID` set — every agent
  PTY gets this per `electron/services/agentEnv.ts`) whose data dir exists but whose
  `server.env` was NOT found, every check whose input came from that shadowed view
  (`auth-token`, `ws-tickets`, `secrets-at-rest`, `agent-sandbox`, `origin-allowlist`,
  `data-dir-perms`, `daemon-json-perms`) is downgraded to `info` and can never render
  `fail`; a synthetic `observation-scope` check is prepended explaining why. `version-stamp`
  and `multi-user` are unaffected — they don't depend on the shadowed data dir. The run
  exits `2` in this mode and the human/`--json` output both say so plainly. Re-run on the
  host (or from an unsandboxed shell) for a verdict that means something.

See also: docs/SECURITY.md (per-mitigation detail), docs/IDENTITY-SEAM.md (the ownership
model rung 4/5 depend on), docs/VERSIONING.md (the release/versioning mechanics §3
references), docs/POD-DEPLOY.md (the Docker pod path, and its Podman gap, FLO-57).
