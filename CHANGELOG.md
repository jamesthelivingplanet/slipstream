# Changelog

All notable changes to Slipstream are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/) — see
[docs/VERSIONING.md](docs/VERSIONING.md) for how the scheme maps to this repo
specifically (schema versioning, build stamping, release flow).

## [Unreleased]

### Added

- Slipstream now has an iOS app (FLO-149), a Capacitor kiosk shell alongside the existing
  Android app — same daemon-served SPA in a WebView, no on-device backend. Push
  notifications work end to end via APNs-through-FCM (one Firebase project covers both
  platforms), and biometric unlock (Face ID/Touch ID) mirrors the Android fingerprint gate.
  The home-screen widget and inline notification reply are deliberately Android-only for
  v1 — see [docs/MOBILE-IOS.md](docs/MOBILE-IOS.md) for the full rundown of what's
  supported and what isn't.
- `electron/services/fcm.ts` sends an `apns` block (sound + `apns-priority: 10`) alongside
  the existing `android` block on notification-bearing pushes, so the iOS app now actually
  receives them.
- Fastlane (`mobile/fastlane/`) and a Codemagic pipeline (`codemagic.yaml`) automate iOS
  builds and TestFlight uploads on every version tag — see
  [docs/MOBILE-IOS.md](docs/MOBILE-IOS.md) for the release flow and the manual App Store
  Connect steps that can't be automated.
- Agent-initiated spawning is now bounded by a configurable `SpawnPolicy` (`maxDepth` /
  `maxChildrenPerSession` / `maxSpawnsPerHour`, 0 = unlimited), enforced in
  `electron/services/agentSpawnService.ts`'s `checkSpawnPolicy` before an agent-requested
  spawn is allowed to launch, and editable under Settings → Behavior. Previously a spawned
  agent's system prompt encouraged delegation and nothing capped the resulting recursion, so
  a single runaway agent could fan out an unbounded number of PTYs and API cost;
  `maxSpawnsPerHour` is scoped per requesting session (counted from that session's own
  children's `createdAt`, reusing the persisted DB row rather than an in-memory counter, so
  the window survives a daemon restart).
- Spend is now a ceiling, not just a readout. A configurable `BudgetPolicy`
  (`perSessionUsdCap` / `dailyUsdCap`, 0 = unlimited, disabled by default) is enforced in
  two places: `electron/services/sessionReaper.ts` reaps a session over the per-session cap
  with a reason that names the budget, and `agentSpawnService.ts` refuses a new
  agent-requested spawn over the daily cap through the same readable-refusal path the spawn
  limits use. Editable under Settings → Behavior. Backends with no usage reader (grok, kilo,
  antigravity, and pi for a cwd-resolution reason — see `supportsUsage` in
  `electron/shared/agents.ts`) are **skipped** rather than read as zero: an unknowable cost
  is not "under budget", and quietly counting it as zero would exempt exactly the sessions
  the cap cannot see while the user believed the cap was global. The Settings copy says so,
  and says that costs are estimates parsed from transcripts, not invoices.
- Self-service device onboarding (`docs/SECURITY.md` §13). An already-authenticated session
  mints a single-use pairing code bound to its own owner (`createPairingCode`,
  `electron/services/devicePairing.ts`), and a new device redeems it at `POST /pair` to
  receive a real device token — replacing "the operator runs `pnpm tokens -- issue` and
  hands the string over" as the only path onto a deployment. `/pair` is the one
  unauthenticated endpoint on an otherwise fully-authenticated daemon, so: codes are hashed
  at rest like device tokens already are, single-use with an atomic burn, ~5 minute TTL,
  128-bit entropy, constant-time comparison, a uniform error across every failure case so
  the endpoint cannot be probed, and rate limiting at 10 attempts/minute per source IP. The
  code travels in the POST body, and the QR deep link carries it in the URL *fragment* — so
  neither reaches a reverse proxy's access log, which is the rung-3 concern in
  `docs/PRODUCTION-READINESS.md` §1. This flow is a deliberate exception to the repo's
  usual "express intent, never hand over a credential" idiom, because delivering a
  credential is precisely its purpose; that is why the constraints above are tight.
- GitHub Issues and GitLab Issues as ticket sources, behind the existing `ITicketProvider`
  seam (`TicketSource` is now `'jira' | 'linear' | 'github' | 'gitlab'`). Both reuse the
  per-host git credentials already stored for the PR/MR path rather than introducing a
  second place to keep the same token, and GitLab honors a configured `baseUrl` so
  self-hosted instances work. Neither has an "in progress" state for a bare issue, so
  `startTicket`/`resetTicket` return `null` per the interface's documented no-op contract
  instead of inventing workflow states.
- Integration credentials are now per-owner rather than deployment-global — the caveat
  `docs/PRODUCTION-READINESS.md` §1 attaches to rung 4 and the blocker it names for rung 5
  (`docs/IDENTITY-SEAM.md` item 6). Config keys are split into two classes: integration
  credentials and their scoping are owner-scoped, while operator policy (`gc.policy`,
  `scheduler.policy`, `spawn.policy`, `budget.policy`, VAPID) stays deployment-global,
  because those describe how the daemon behaves rather than who a person is. Ticket
  providers are no longer startup singletons — `electron/core/services.ts` exposes an
  ownerId-keyed factory and every call site resolves the real caller identity first, so the
  scoping is actual and not merely structural. Existing rows migrate to the `local`
  identity, so a single-owner deployment sees no behavior change. At-rest encryption
  (`ss1:`/`sk1:`) is unchanged and still applies to exactly these keys. Still open, and
  recorded as such: git-push credential reads in `prStatus.ts`/`gitDriver.ts`/`slipstream.ts`,
  and per-owner data directories (item 5).

### Security

- The Android daemon bearer token is no longer kept in plaintext. `ReplyPrefs` now uses
  `EncryptedSharedPreferences` backed by an `AndroidKeyStore` `MasterKey`, still readable
  unattended by `ReplyReceiver` when the app process is dead (which is why the copy exists
  at all). An existing plaintext value migrates on first access and is deleted; a Keystore
  initialization failure degrades to "inline reply unavailable" and never falls back to
  plaintext. This is the mitigation `docs/UX-GO-NO-GO.md` B6 requires if the cut claims the
  Android shell. It is compile-verified only — four runtime behaviors (Keystore init, the
  migration against a real prior install, background decrypt-and-POST with the process
  dead, and the degrade path) need a device, so treat B6 as "mitigation implemented, not
  field-verified" until then. Per `docs/SECURITY.md` §6's threat model this still does not
  defend against a same-uid reader.

### Fixed

- Settings → Security (device pairing codes, fingerprint unlock) is now visible outside the
  Capacitor mobile shell. It was previously gated behind the same `nativeStorage.isAvailable()`
  check as the mobile-only "Server" tab, which made the pairing flow's primary use case —
  generating a code on an already-authenticated desktop/web session to onboard a new
  phone — unreachable in the UI. The "Server" tab (runtime daemon URL) stays native-only;
  only "Security" widened (`src/lib/components/SettingsModal.svelte`).
- A "blank chat" session's `mode` is now persisted directly on the `sessions` row by
  `db.ts`'s `upsertSession` (the column was added by migration 10 in
  `electron/db/migrations.ts`), so it survives a daemon restart; handing a chat session off
  to a different agent now composes a chat-flavored takeover prompt
  (`buildChatHandoffPrompt`, `electron/shared/promptComposer.ts`) instead of the ticket one,
  which previously carried a ticket tid, base branch, and open-a-merge-request framing that
  the chat system prompt deliberately strips out.
- Kilo chat now reads kilo's own `kilo.db` instead of opencode's `opencodeDb`. Kilo is an
  opencode fork with a schema-identical store, so the message reader
  (`electron/services/sessionChatReader.ts`) is shared rather than forked between the two
  backends; previously a kilo session's id was looked up in the wrong database and the chat
  panel always reported "no chat available". Note that the JSON shape of kilo's `data`
  column has only been verified against the schema so far, not yet against a recorded kilo
  session.
- Backend capability claims (chat / usage / skills support) are now a single matrix,
  `AGENT_META_BY_KIND` in `electron/shared/agents.ts`, that `usage.ts`, `agentSkills.ts`, and
  `sessionChatReader.ts` all read from, replacing three separately-maintained restatements of
  the same per-backend truth that had drifted out of sync with each other. Several stale
  capability claims in `contract.ts`'s own doc comments were corrected at the same time.

## [0.10.0] - 2026-07-30

### Added

- Agents can now delegate work by spawning independent sibling agents, and the app gains a
  blank "New chat" session kind alongside the existing ticket-driven flow (TASK-CIOEQ). A
  token-free agent session's `slipstream` CLI can only write to its own
  `<dataDir>/sessions/<id>/` sentinel dir (the one path bind-mounted rw inside the bwrap
  sandbox), so it now has a file-based request/response channel to ask the daemon for
  privileged things: `electron/services/agentRequestSentinel.ts` defines the
  `requests.ndjson`/`responses.ndjson` line formats (`new-agent`/`repos`/`agents` request
  kinds); `sentinelWatcher.ts` tails `requests.ndjson` alongside the existing sentinel
  files and fires a new `onAgentRequest` callback per line; `sessionManager.ts` re-emits
  it as an `agentRequest` session event; and `electron/services/agentSpawnService.ts` is
  the sole consumer — it resolves the requesting session's owner, validates and
  owner-scopes the repo lookup, mints a tid, and launches through the same
  `scheduler.submit`/`launchSession` path the UI's own `startSession` RPC uses, answering
  via `responses.ndjson`. Because launching an agent isn't idempotent, the service seeds
  already-answered request ids from every session's `responses.ndjson` before it starts
  processing, so a daemon restart (which replays the whole of `requests.ndjson`) can't
  double-spawn. `sessions.parentId` (DB migration 9, `contract.ts`, `sessionLauncher.ts`)
  tracks which session spawned which.

  Three new `slipstream` CLI commands expose this to agents: `new-agent --repo <org/name>
  --title <t> [--prompt <p>] [--agent <kind>]` spawns a sibling agent and prints its tid,
  session id, and branch; `repos` lists the repos an agent can target; `agents` lists what
  it has spawned and their status. Each sends a request and polls `responses.ndjson` for
  the matching id (60s timeout for `new-agent`, 15s for `repos`/`agents`). The command
  registry (`electron/shared/slipstreamCommands.ts`), the ticket-agent system prompt
  (`promptComposer.ts`), and the `slipstream` worktree skill (`cliSkillDoc.ts`) all
  mention the new delegation capability, in their own voice.

  A session can also now be started in "blank chat" mode (`mode: 'chat'` on `startSession`,
  `electron/core/rpcHandlers/sessions.ts`): a new `buildChatSystemPrompt()` frames the
  agent as a conversational assistant with no ticket and no merge request to open unless
  asked, and reframes `slipstream request-input` as the agent's normal per-turn resting
  state rather than something reserved for being stuck; the ticket-provider `startTicket`
  side effect is skipped (`LaunchRequest.skipTicket`, `sessionLauncher.ts`) since a chat
  session's tid is synthetic. The renderer gains a "New chat" entry point (a home-screen
  FAB and dialog, `src/lib/components/NewChatDialog.svelte` + `NewAgentFab.svelte`) that
  mints a `CHAT-XXXXX` tid client-side and starts the session with `mode: 'chat'`.
- `docs/UX-GO-NO-GO.md` (FLO-148) — the core-UX half of the production go/no-go, which
  FLO-142 named as its one unresolved sub-issue and deliberately left to a judgement call.
  Inventories every in-flight core-UX workstream (chat-by-default, per-backend chat, the
  Android/iOS/PWA halves of Night Ops parity, Mission Control, app-store distribution) and
  classifies each as must-land / behind-a-flag / post-prod rather than leaving it implicit;
  states the bar as six checkable criteria (no breaking `contract.ts`/`wire.ts` edit in the
  trailing three releases, no dead-end views, chat-by-default reversible and sticky,
  per-platform parity stated not implied, every row classified with a ticket, no
  un-mitigated MED+ UX item); and sequences the UX freeze *after* FLO-142's five hardening
  blockers rather than alongside them, since a UX change can invalidate a hardening
  assumption but not the reverse. Names the two concrete open items the inventory turned up:
  kilo declares `supportsChat: true` but shares the `usesEmbeddedServer` durable fallback,
  which is hardcoded to opencode's DB path, so its post-exit chat is unverified — verify or
  demote the flag before a cut; and the Android inline-reply token is still a plaintext
  `MODE_PRIVATE` copy (`ReplyPrefs.java`), which needs Keystore-backing or a written
  accepted-risk entry if the cut claims the Android shell. Ends with a sign-off table where
  an unfilled row is a no-go, so the call is agreed rather than assumed.
- Opt-in fingerprint gate on the Android app's saved server token (FLO-159).
  The mobile app's stored bearer token is a live credential for the whole
  daemon, and until now the only thing standing between an unlocked, handed-
  over phone and that token was the OS's own app/device lock. `Settings >
  Security` (native-shell only) adds a "Require fingerprint to unlock"
  toggle — off by default — that, once turned on, requires a passing
  `BiometricPrompt` (`BIOMETRIC_STRONG | DEVICE_CREDENTIAL`, so device PIN
  still works as a fallback on hardware with no enrolled fingerprint) before
  the app will read the token back out of storage. The gate is enforced at
  the storage seam itself — `nativeStorage.ts`'s `get(TOKEN_KEY)` returns
  `null` while locked — rather than only at boot, so every reader of the
  token is gated, not just the app-open path. Because Android keeps the
  Capacitor WebView alive across backgrounding instead of reloading it, the
  gate also re-arms on resume: coming back from the background past a short
  grace period re-locks the token even mid-session, not just on a cold
  start. A "Sign out" escape hatch on the lock screen clears the saved token
  and disables the preference for anyone who abandons or fails the prompt,
  so a lost fingerprint match can never stall someone in front of a gate
  with no way out other than reinstalling.
- Stop/Restart buttons on the home-screen widget's session rows (FLO-162),
  built on a deliberate re-architecture rather than the naive add-on the
  ticket was filed to head off. The widget's render path has no auth token
  and no network access by design — a straight `BroadcastReceiver` calling
  the daemon off a tap would have had to route the bearer token onto that
  token-free surface, or read it out of storage with no UI to confirm
  anything against. Instead, a tap now only stashes an intent (session id +
  action) in app-private storage and launches the app; the SPA, which
  already holds the token behind the FLO-159 biometric gate, reads that
  intent back (read-and-clear, so a tap fires at most once, with a 2-minute
  TTL so a stale tap can never act on later session state) and performs the
  action itself. `Restart` maps straight to a recoverable resume RPC, but
  `Stop` still raises the app's own "this discards uncommitted work"
  confirm dialog before tearing the session down — the concrete reason Stop
  couldn't be backgrounded regardless of the token question, since a
  headless receiver has nowhere to show that prompt. The accepted trade-off
  is that every widget action now costs a foreground launch and, if the
  gate is armed, a biometric unlock — not a one-tap background action —
  which is the deliberate price of keeping the token out of the widget
  process entirely. Two alternatives were considered and rejected: reusing
  the FLO-151 `ReplyPrefs` plaintext token stash (cheapest, but extends a
  stash its own doc comment calls prototype-grade to permanent home-screen
  buttons outside the biometric gate, and still can't show the confirm);
  and short-lived single-use action grants generalizing the FLO-144 one-time
  WS ticket pattern (the only design that would allow true no-launch
  actions, but needs a new minting endpoint, a grant lifecycle, and a
  second at-rest credential stash, and still leaves Stop compromised). See
  docs/SECURITY.md §12 for the full threat model and revisit criteria, and
  docs/ARCHITECTURE.md's new "Mobile home-screen widget" subsection for the
  two-channel shape.

### Fixed

- The widget row's plain tap (open the app to a specific session) was a
  dead deep link before FLO-162, discovered and fixed as a side effect of
  the Stop/Restart work above. `MainActivity` dispatched a
  `slipstream:widget-open` DOM event via `evaluateJavascript()` that
  nothing in the SPA listened for, and on a cold start it fired before the
  page had even loaded; separately, `subscribeWidgetAgentOpen()` bound a
  Capacitor `'openAgent'` listener that no native code ever emitted. Two
  halves that never met, so a row tap did nothing but open the app. The new
  intent-stash mechanism (a plain tap defaults to an `"open"` action)
  replaced the unreliable `evaluateJavascript` dispatch and made row-tap
  deep-linking work for the first time.
  `subscribeWidgetAgentOpen()` itself was deliberately left in place — its
  Capacitor 6-vs-7 dual-shape handling is separately tested — but remains
  unfired by any native code path; it is not a live channel.

## [0.9.0] - 2026-07-29

### Added

- `docs/PRODUCTION-READINESS.md` (FLO-142) — the roll-up doc for "is Slipstream
  production ready," organized around the idea that the question only means something
  against a named deployment posture. Lays out a five-rung posture ladder (desktop-only,
  Tailscale-remote, reverse-proxy-fronted, multi-device operator-provisioned, and public
  untrusted multi-tenant) with what each wider rung requires and its honest residual gaps;
  a status table for FLO-142's five hardening sub-issues (multi-user tokens FLO-143,
  WS tickets FLO-144, secrets at rest FLO-145, the bwrap sandbox FLO-146, and versioning
  FLO-147 — all shipped, each with a stated residual gap rather than a bare "done"); and
  go/no-go criteria for declaring a production cut, split into mechanical gates (checked
  by `pnpm readiness`/`pnpm check`/`pnpm test`/`pnpm lint`/`pnpm release`/`/healthz`) and
  scope-stability gates (Night Ops parity, the opencode/pi chat interface, and
  chat-by-default must each be shipped-and-stable or explicitly deferred — not left as an
  implicit "it feels done," which is what FLO-142's own remaining sub-issue called out).
- `pnpm readiness` (`scripts/readiness.mjs` + the pure evaluator in
  `scripts/lib/readiness.mjs`) — inspects a live deployment (`server.env`, the data dir's
  permissions, and whether `bwrap` is on `PATH`) and reports, one line per check, whether
  each hardening gate from the FLO-142 blockers is actually *active* on this host, as
  opposed to merely shipped in the codebase. Nine checks (`auth-token`, `ws-tickets`,
  `secrets-at-rest`, `agent-sandbox`, `origin-allowlist`, `data-dir-perms`,
  `daemon-json-perms`, `version-stamp`, `multi-user`), each pass/warn/fail/info with a doc
  pointer; supports `--json`. Its most important job is catching the sandbox's fail-open
  case: `SLIPSTREAM_SANDBOX=bwrap` set with no `bwrap` binary on `PATH` silently runs
  agents unsandboxed (`agentSandbox.ts`'s availability check), which this reports as a
  `fail` rather than letting it hide behind a config value that merely looks correct.
  Deliberately can't see inside the DB, so device-token/multi-owner state is out of scope
  for this command — use `pnpm tokens -- list` for that. Detects when it is itself running
  inside a bwrap-sandboxed agent PTY — the sandbox overmounts the data dir with a private
  tmpfs (`server.env`/`daemon.json`/`secret.key`/the real dir mode all invisible), so a
  naive run would fabricate FAILs (missing token, wrong perms) for a host that's actually
  fine. When detected, the seven checks that depend on that shadowed view are downgraded
  to `info`, a synthetic `observation-scope` check is prepended explaining why, and the
  run is reported as **inconclusive** rather than clean. Exit code is now a triple: `0`
  no fail, `1` at least one fail, `2` inconclusive (sandbox-shadowed) — a deploy gate
  should treat any non-zero exit as "not a clean bill of health."

### Fixed

- Three doc surfaces had gone stale relative to shipped hardening work, in ways that
  actively understated the current security posture rather than just being outdated
  trivia: README.md's "Secrets & data directory" section still said the headless
  server/detached daemon kept config-table secrets (Linear key, git tokens) plaintext,
  protected only by the data dir's 0700 permissions — that was true before FLO-145 shipped
  server-side `sk1:` AES-256-GCM encryption (keyed by `SLIPSTREAM_SECRET` via scrypt, or a
  file-backed `secret.key` fallback) and has been stale since. docs/SECURITY.md §7's threat
  writeup still described those same values as flatly plaintext in its "what a same-uid
  agent can read" bullet, which would have made the surrounding argument (that the env-scrub
  in §7 is hygiene, not a boundary) look like it rested on a claim that was no longer true;
  reworded to state the real residual reason the threat still stands post-FLO-145 — the key
  material itself (`secret.key`, or `SLIPSTREAM_SECRET` in the daemon's environment) is
  readable by that same uid, so decryption is one step away rather than zero, but the
  outcome for a same-uid attacker is unchanged. docs/IDENTITY-SEAM.md's "What's still open"
  item 4 still described the one-time WS ticket endpoint as "design only, not yet
  implemented," when FLO-144 shipped it; reworded in the struck-through "Done (FLO-…)" style
  already used for items 1 and 3, preserving the still-true substance that tickets are minted
  per-token through this same identity seam.
- Chat view: a single subagent run no longer fragments into a wall of "Subagent work
  (unmatched)" rows. Its whole transcript is now grouped as one collapsible row, keyed by a
  stable per-run id the backend stamps on every message of the run — the old bucketing (by
  walking `parentUuid` chains) broke apart whenever an unrenderable transcript line was
  dropped mid-chain, splitting one subagent run into many disconnected one-message groups
  (TASK-1V8H8).
- Subagent/tool rows in chat now render on a single line (with an ellipsis when the summary
  is too long to fit) and show their full text plus the nested transcript once expanded
  (TASK-1V8H8).
- Orphaned subagent rows are now labeled with the subagent's actual description/agent type
  instead of the generic "Subagent work (unmatched)" (TASK-1V8H8).
- Nested subagents — a subagent that itself spawned a further subagent — now render inside
  their parent's transcript instead of being listed separately as unmatched (TASK-1V8H8).

## [0.8.1] - 2026-07-29

### Fixed

- `git` over SSH — and bare `ssh` — was completely broken inside the bwrap agent sandbox,
  so an agent running under `SLIPSTREAM_SANDBOX=bwrap` could not push, pull, fetch, or open
  a merge request. bwrap's unprivileged user namespace maps only the sandboxed uid
  (`uid_map: 1000 1000 1`), so every root-owned file appears owned by `nobody` inside the
  namespace — including the distro's `/etc/ssh/ssh_config.d/*.conf` client-config drop-ins
  that `/etc/ssh/ssh_config` pulls in via `Include`. OpenSSH treats a config it cannot
  vouch for as fatal rather than skipping it, so every SSH invocation died with
  `Bad owner or permissions on /etc/ssh/ssh_config.d/…` before it ever reached the network.
  `electron/services/agentSandbox.ts` now adds a `--tmpfs` over `/etc/ssh/ssh_config.d`
  (that directory only, and only when it exists on the host), so the unloadable drop-ins
  are simply absent inside the sandbox and the `Include` glob matches nothing. Everything
  that carries real configuration is left alone: `/etc/ssh/ssh_config` itself, and the
  user's own `~/.ssh/config`, keys and `known_hosts` — so host aliases, per-host
  `IdentityFile`, and `StrictHostKeyChecking` keep behaving exactly as configured, and host
  key checking is not weakened. No `GIT_SSH_COMMAND`/`-F` override is injected into the
  agent's environment, which is why this fixes plain `ssh` too and not just git, and why it
  cannot clobber a value the user sets themselves. Note this is daemon-side: the fix
  reaches running agents only after the next `slipstream.service` restart, since
  `buildBwrapArgs` runs in the daemon that spawns the PTY.

## [0.8.0] - 2026-07-28

### Fixed

- The dev-slot registry (`~/.config/slipstream/dev-slots.json`) and per-slot env files
  (`~/.config/slipstream/dev-slots/<slug>.env`) lived under prod's data dir, which every
  sandboxed agent PTY now gets a private tmpfs over by default (`SLIPSTREAM_SANDBOX=bwrap`,
  on by default for new dev slots). A `pnpm deploy` run from inside such an agent wrote its
  slot's env file into that agent's private, host-invisible tmpfs copy, so systemd's
  `slipstream-dev@<slug>.service` failed to restart with `Failed to load environment files:
  No such file or directory`; separately, `acquire`/`pnpm dev:slots` saw an empty registry
  from inside the sandbox and would have re-allocated ports already in use on the host. Both
  now live under `~/.local/share/slipstream-dev` (`slots.json` and `slots/<slug>.env`,
  alongside the already-relocated per-slot data dirs), which is never tmpfs-shadowed.
  `scripts/lib/devSlots.mjs`'s `readRegistry()` best-effort migrates an existing
  pre-TASK-WH96T registry and its env files from the old location the first time it runs, so
  upgrading doesn't strand an already-running dev slot. `scripts/deploy.sh`'s dev path now
  also reads back the per-slot env file immediately after writing it and fails the deploy
  loudly (naming sandbox/tmpfs shadowing as the likely cause) if the read-back doesn't match
  what was written, instead of silently proceeding into a restart that can't work.
  `scripts/lib/prodGuard.mjs`'s now-obsolete `~/.config/slipstream/dev-slots` carve-out
  (writes there used to be allowed as "dev state") was removed — nothing legitimate writes
  under prod's data dir anymore, so it's protected uniformly like the rest of
  `~/.config/slipstream`.

- `node scripts/dev-slot.mjs prune` dropped a slot's registry entry and released its
  Tailscale mapping when the worktree's directory was gone, but never stopped or disabled
  that slot's `slipstream-dev@<slug>.service` unit, nor removed its per-slot env file —
  unlike `dev-slot.mjs down`, which did all four. A worktree deleted right after its MR
  merged left the dev instance running indefinitely: still holding its port and tsPort
  mapping, still systemd-enabled, so it would come back on reboot in a `Restart=on-failure`
  loop against a directory that no longer exists. `prune` and `down` now share one
  `reclaimSlot()` helper (`scripts/dev-slot.mjs`) that performs all four teardown steps —
  each independently best-effort so one failure can't abort the rest of a slot's teardown or
  a prune run's remaining slots — and `prune`'s output now reports what was actually
  reclaimed per slug. Added `isDevUnit()` (`scripts/lib/devSlots.mjs`) as an explicit,
  unit-tested guard so a malformed or hostile slug can never produce a unit name that
  `reclaimSlot()` would hand to `systemctl`, unless it starts with `slipstream-dev@`.

## [0.7.0] - 2026-07-28

### Fixed

- Mission Control's needs-you cards no longer overflow their container or
  render at inconsistent widths on phone-width screens. The `.cards` grid's
  auto-fit track floor was a fixed `300px`, wider than `.mc-inner`'s content
  box at a 360px viewport, so the grid overflowed by 12px; the floor is now
  `min(300px, 100%)` so it can shrink with the container without changing
  desktop's multi-column layout. `.card` buttons were also missing the
  `width: 100%` that `.row` already carries, so a `<button>`'s shrink-to-fit
  sizing made cards render at different widths depending on title length.
  The mobile media query's side padding on `.mc-inner` was also reduced from
  36px to 16px so it's no longer a disproportionate share of a narrow screen.

### Added

- `pnpm setup` now manages `SLIPSTREAM_SANDBOX` in `~/.config/slipstream/server.env`
  automatically, so production's bwrap agent-sandbox containment
  (`electron/services/agentSandbox.ts`) no longer requires a manual, hand-edited opt-in. A
  fresh `server.env` gets `SLIPSTREAM_SANDBOX=bwrap` written by default; an *existing*
  `server.env` missing the key gets it appended the same way — both take effect on the next
  `slipstream.service` restart (e.g. `pnpm deploy`). Pass `--sandbox=none` to opt out (fresh
  installs) or leave containment off (existing installs). The key is **sticky**: once a
  `SLIPSTREAM_SANDBOX=` line exists in `server.env`, including an explicit `none`,
  `pnpm setup` never touches it again on a re-run — an operator's past choice, opt-out
  included, always wins over whatever `--sandbox=` value is passed later. The append/leave-
  alone decision for an existing file is pure logic in the new `scripts/lib/serverEnv.mjs`
  (unit-tested in `scripts/lib/serverEnv.test.mjs`), invoked via a small CLI shim
  (`scripts/server-env.mjs`) that mirrors the existing `scripts/dev-slot.mjs` pattern, so
  `scripts/setup.sh` doesn't have to reimplement the grep/append logic a second time in bash.

### Fixed

- `pnpm setup` could silently repoint this machine's *production* Slipstream service at a
  linked git worktree — a real security hole, not just a footgun. `scripts/setup.sh` derives
  everything it writes (a systemd unit's `WorkingDirectory=`, `~/.config/slipstream/server.env`)
  from its own script location (`REPO_ROOT`), with no target-awareness at all: unlike
  `scripts/deploy.sh`, which has an explicit `slipstream_is_linked_worktree` guard that
  refuses to deploy `prod` from a worktree, `setup.sh` had no equivalent check, and neither of
  the repo's other prod guards covered it — `deploy.sh`'s target guard only runs inside
  `deploy.sh`, and the PreToolUse hook (`scripts/guard-prod.mjs`/`scripts/lib/prodGuard.mjs`)
  doesn't recognize `pnpm setup`/`bash scripts/setup.sh` as a deploy action. The practical
  failure mode: running `pnpm setup` inside a per-ticket worktree under `.claude/worktrees/`
  would overwrite `~/.config/systemd/user/slipstream.service`'s `WorkingDirectory=` to point
  at the worktree instead of the main checkout, and would create/modify
  `~/.config/slipstream/server.env` as if configuring production — so the next
  `systemctl --user restart slipstream.service` (e.g. from `pnpm deploy` run anywhere, or a
  reboot) would start production against the wrong, possibly-transient checkout. `setup.sh`
  now sources `scripts/lib/target.sh` and detects a linked worktree the same structural way
  `deploy.sh` does (`git rev-parse --absolute-git-dir` vs `--git-common-dir`, not path
  matching), and when true, skips writing/enabling `slipstream.service` (or the macOS
  LaunchAgent) and skips creating or modifying `server.env` entirely — printing a loud,
  unmissable notice explaining what was skipped and why. It still runs everything a worktree
  genuinely needs: prereq checks, `pnpm install`, the native-ABI rebuild, and the
  dev-instance scaffolding. Behavior from the main checkout is unchanged apart from the
  `SLIPSTREAM_SANDBOX` handling described above.

- The PreToolUse prod guard denied `cp <prod-file> <scratch-dest>` — a read — because
  write-command checking scanned every argument rather than the operand the command
  actually mutates. That also blocked taking a backup of `slipstream.db`, exactly the
  kind of false positive `prodGuard.mjs`'s own header calls worse than a missed bypass.
  Argument checking is now positional per command: `cp`/`install` check the destination
  (last non-flag argument, or a `-t` target), `dd` checks `of=` rather than `if=`, while
  `mv`/`ln`/`rm`/`truncate`/`chmod`/`chown`/`touch`/`mkdir`/`sqlite3`/`tee`/`sed -i` keep
  all-argument checking because every operand there is something they mutate. `mv` stays
  strict where `cp` relaxed because a prod path as *source* still means prod loses the file.

## [0.6.0] - 2026-07-28

### Added

- opencode chat history now survives the session ending instead of vanishing
  the moment the TUI process exits or the daemon restarts. `sessionChatReader.ts`
  previously read opencode messages only from the live embedded HTTP server's
  in-memory state — the only source claude-code (JSONL transcript) and pi
  (session file) never needed, since both were durable from the start. It now
  falls back to opencode's own durable SQLite store (`~/.local/share/opencode/
  opencode.db`, `opencodeStore.ts`) keyed by the `opencodeSid` already
  persisted alongside the session row, reusing the existing opencode→chat
  mapper so the two sources render identically. The live server is still
  preferred when reachable — it's the only source for a brand-new session
  that hasn't been flushed to the durable store yet.

- grok conversations now appear in the chat view; grok was previously
  terminal-only (`supportsChat: false`), the same as antigravity still is.
  grok persists every session/message to its own SQLite database at
  `~/.grok/grok.db` (verified against grok-dev v1.1.7's compiled source); a
  new reader (`grokStore.ts`) and pure mapper (`grokChatMessages.ts`) surface
  it through the same `readSessionChat` dispatch the other backends use.
  Unlike opencode, Slipstream doesn't persist a grok session id on the
  session row, and grok has no live embedded-server source to capture one
  from — so selection happens by worktree instead: the reader finds grok's
  `workspaces` row for the session's cwd and takes the newest `sessions` row
  under it, mirroring grok's own `--session latest` resume semantics (same
  idea as pi's newest-file selection, different store shape). grok's stored
  format is the Vercel AI SDK `ModelMessage` shape (`role: 'system' | 'user'
  | 'assistant' | 'tool'`), mapped onto the DTO's two-role shape the same way
  claude-code's transcript is: tool results ride as a synthetic user turn.

- Subagent work is no longer invisible in the chat view. Claude Code writes
  each Task-style subagent run to its own transcript beside the main one
  (`<sessionId>/subagents/agent-<agentId>.jsonl`), and Slipstream read only
  the main file — so the chat showed the spawning call and its final result
  with everything in between missing. Those files are now read and merged,
  and each run is threaded back to the `Agent` tool_use that spawned it via
  the `toolUseId` in its sibling `.meta.json` (this held for 242 of 243 real
  subagent runs on the development machine; nested subagents anchor through
  their ancestor). The renderer nests each run under that call, collapsed by
  default — subagent output can be several times the size of the
  conversation it belongs to, so inline rendering would bury the thread.

- The chat view renders extended thinking and images, which were previously
  parsed and then dropped on the floor. Thinking is collapsed and
  de-emphasized by default; images render inline, closing a longstanding
  asymmetry where a chat message could carry an image *to* the agent but
  never show one coming back. Applies to every backend whose store carries
  them (claude-code, pi, opencode's `reasoning` parts, grok's AI-SDK
  reasoning/image parts).

- `Edit` and `Write` tool calls render as a real diff instead of a JSON blob
  containing `old_string`/`new_string`, reusing the diff renderer the review
  panel already uses, and `TodoWrite` renders as a status-coloured checklist.
  Tool summaries also now cover the tools that actually appear in practice —
  `Agent`, `ToolSearch`, `Skill`, `AskUserQuestion`, `TaskCreate`/`TaskUpdate`
  and the `mcp__<server>__<tool>` naming pattern all previously fell through
  to a bare "Used <name>".

### Changed

- Electron upgraded 33.4.11 → 39.8.10, clearing four high-severity advisories
  that applied to the shipped desktop runtime (TASK-N6X4R): renderer
  command-line switch injection (GHSA-9wfr-w7mm-pc7f) plus three use-after-frees
  (GHSA-8337-3p73-46f4, GHSA-jjp3-mq3x-295m, GHSA-532v-xpq5-8h95). The
  switch-injection one is the reason this was prioritised: `main.ts` passes the
  daemon bearer token to the renderer via `additionalArguments`, exactly that
  surface. `electron-builder` moved to 26.15.7 and `electron-builder.yml`'s
  hardcoded `electronVersion` with it — it pins the packaged runtime
  independently of `package.json`, so a bump that misses it silently keeps
  shipping the old version. No application code needed changing: every
  breaking change across 34→39 was checked against this codebase and none of
  the affected APIs are used.

- `better-sqlite3` upgraded 11.x → 13.0.1, forced by the above: 11.x fails to
  compile against Electron 39's V8, which removed the deprecated
  `Context::GetIsolate()` its binding relied on. 13.0.0 is the first release
  built on N-API, which is ABI-stable — so the module no longer needs
  rebuilding per runtime. Verified directly: with the module built for Node
  (ABI 127) it opens a database and runs queries unchanged under Electron
  (ABI 140).

- `package-lock.json` is gone (TASK-N6X4R). Nothing installed from it — CI runs
  `pnpm install --frozen-lockfile` and the repo is pnpm-only — and the sole
  script that touched it was `scripts/release.sh`, which bumped only its
  embedded version field. Because just that field was maintained, its
  dependency graph had drifted: it was missing `dompurify`, `marked` and
  `qrcode`, so `npm audit --omit=dev` read it and cheerfully reported "0
  vulnerabilities" for a runtime tree excluding the markdown parser and the
  XSS sanitizer. `pnpm audit --prod` agreed on the number, but the npm-side
  signal could not be trusted to keep agreeing. The release script now bumps
  and commits `package.json` alone (rollback semantics unchanged), and the
  file is gitignored so a stray `npm install` cannot silently reintroduce it.

### Security

- The daemon now sends a `Content-Security-Policy` on HTML/static responses
  (TASK-N6X4R). The SPA is served to real browsers over Tailscale or a reverse
  proxy and renders agent-transcript markdown through `{@html}`, so although
  `src/lib/markdown.ts`'s DOMPurify gate is the real defense, transcript
  content is attacker-influenced (it is whatever the agent read) and a CSP is
  the cheap second layer if that sanitizer is ever bypassed. `script-src` is
  `'self'` with no `'unsafe-inline'`/`'unsafe-eval'` — the directive that
  actually blocks XSS. `style-src` does allow `'unsafe-inline'`, a deliberate
  trade-off: Svelte scoped styles, Tailwind arbitrary values, and xterm.js's
  runtime-injected `<style>` element leave no nonce to plumb through, and
  inline *style* cannot execute script. JSON endpoints (`/healthz`,
  `/rpc-ticket`, `/inline-reply`) are excluded, and the whole header can be
  disabled per-deployment without a code change. See
  [docs/SECURITY.md](docs/SECURITY.md) §10.

- `cleanupSession` cancelled a queued session in the scheduler *before*
  checking who owned it (TASK-N6X4R), so a caller holding a per-device token
  for one owner could drop another owner's queued run and still receive the
  indistinguishable "session not found" response the no-existence-leak
  convention requires. The ownership check now runs first; cancellation still
  precedes the store-row delete, so the scheduler-drain race the original
  ordering guarded against is unaffected. Every other handler in that file was
  audited and already ordered correctly.

### Fixed

- The chat view no longer invites you to talk to an agent that has no chat.
  For a backend with no chat reader (antigravity), the empty state said "No
  messages yet — start the conversation below" — a message that could never
  come true, since nothing would ever populate it. The empty state now
  distinguishes three cases: this agent has no chat view at all (steers to
  the terminal instead), nothing could be recovered from this backend's
  store right now, and the conversation is genuinely empty so far. Long tool
  output in a chat message is also now height-capped with a scroll
  container instead of rendering in full, which could previously push the
  rest of the conversation far off-screen.

- Chat pagination counts the conversation, not the subagent transcripts
  merged into it. Now that a page carries each turn's subagent messages
  alongside it, a page's raw length and first-element timestamp are both
  unreliable: on a subagent-heavy session the extra messages outnumber the
  conversation several times over, which would have left "load older"
  permanently available and could have paginated from a subagent's
  timestamp — subagents run *during* the turn that spawns them, so their
  timestamps can precede it. Both the more-available check and the
  pagination cursor now consider main-thread messages only, and the page
  limit applies to the conversation so subagent detail can never crowd it
  out.

- `server.log` rotation could lose and reorder lines, and never actually
  enforced its 10 MiB cap (TASK-N6X4R). `server()` appended asynchronously but
  tracked size synchronously and rotated with a synchronous `renameSync`, so
  appends still in flight when the rename fired landed in the fresh
  `server.log` instead of the rotated `server.log.1` — including the
  `uncaughtException` context this log exists to preserve across restarts. All
  rotation and append work is now serialized through one promise chain, so a
  rotation can never overlap an outstanding write and the byte count only
  advances once a write has landed. `server()` stays fire-and-forget and
  non-blocking for callers. This was also the repo's one intermittently
  failing test: it only failed under full-suite I/O load and passed in
  isolation, so it read as flake rather than the real race it was.

- An oversized body posted to `/inline-reply` returned a connection reset
  instead of the `413` the handler intended (TASK-N6X4R). `req.destroy()` was
  called on exceeding the 16 KiB cap, which meant `'end'` never fired and the
  `413` branch was unreachable dead code. The response is now written directly
  when the cap is crossed. The size guard also called `Buffer.concat` on every
  chunk, making it quadratic in chunk count; it now tracks a running total.

## [0.5.0] - 2026-07-27

### Fixed

- The per-worktree dev deploy target shipped in 0.4.0 could not actually start
  an instance (TASK-WH96T). Four defects, all found by running a real
  `pnpm deploy` from a worktree rather than by unit tests: the systemd instance
  name was `systemd-escape`d (`-` → `\x2d`) while the env file was written under
  the unescaped slug, so `%i` never resolved and systemd reported "Failed to
  load environment files" for any slug containing a hyphen; the generated
  `dev-serve.sh` was invalid bash because an apostrophe inside a `${VAR:?word}`
  expansion opened an unterminated quote; a worktree's native modules were
  never rebuilt for Electron's ABI, so the daemon died with `ERR_DLOPEN_FAILED`
  before it could open its database; and `pnpm dev:down` released the slot but
  left a `tailscale serve` mapping pointing at a dead port. The scaffold now
  `bash -n`-validates the wrapper it generates, and the dev path verifies the
  native ABI by really loading `better-sqlite3`/`node-pty` under the repo's own
  electron binary and rebuilds when that fails, so none of these can reach
  systemd silently again.

## [0.4.0] - 2026-07-27

### Added

- Voice-to-text (dictation) input for the mobile terminal composer (FLO-155).
  A new mic toggle sits in `MobileTermInput`'s input row and, inside the
  Capacitor mobile shell, drives the native
  `@capacitor-community/speech-recognition` plugin — Android WebViews have
  no usable Web Speech API, so a browser-only implementation would simply
  never work there. Outside the shell (the installed PWA, a desktop browser
  tab) it falls back to the standard Web Speech API. Both backends report a
  replace-everything "best so far" transcript on every partial result rather
  than an incremental delta, which `speech.ts`'s `appendTranscript` merges
  onto whatever was already in the composer when dictation started; the
  merged text is then run through the *same* `ptySequenceForEdit` diff path
  regular typing uses, so live dictation refinements reach the PTY as cheap
  minimal edits rather than a wholesale retype. The native path also polls
  `isListening()` every 2s as a watchdog, since the Android plugin has no
  error channel once `start()` resolves and a recognizer timeout can strand
  the UI in "listening" forever without it. The mic button renders only when
  `dictationAvailable()` finds either backend, so devices with neither (most
  desktop browsers, some WebViews) see no button at all — `src/` still never
  imports `@capacitor/*`, feature-detecting `window.Capacitor` at runtime
  like every other native bridge in this codebase.

- Web push notifications for a "needs input" ask now carry action buttons —
  quick Approve/Deny for approval-shaped asks (sent as a canned `y`/`n` reply)
  and a plain View for other needs asks (FLO-150). The service worker's
  `showNotification` sets the `actions` array (previously unused);
  `notificationclick` routes `event.action` to either deep-link the agent
  (the existing `postMessage({type:'open-agent'})` path) or POST the canned
  reply to the daemon's existing `/inline-reply` endpoint (added for FLO-151's
  native RemoteInput path) — reusing its bearer auth and per-owner ownership
  check rather than adding a new RPC. The SW can't reach the page's in-memory
  `writeSession`, so the page pushes the daemon origin + bearer token to the
  SW (postMessage → IndexedDB) on connect and clears them on logout, mirroring
  the native shell's `saveReplyCredentials`. Android/Chrome render the buttons;
  Safari/iOS ignore the `actions` field (unsupported there as of 2024) and
  degrade to the prior single-tap deep-link, so no parity is promised there.
  Any reply failure (no stashed creds, stale token, network) falls back to
  opening the session so the tap is never a silent no-op. The push payload now
  carries `meta.reason` so the SW can pick the right buttons.

- Typed input is buffered client-side and flushed on reconnect instead of
  being silently dropped when the WebSocket drops mid-type on a flaky mobile
  connection (FLO-154). `wsApi.writeSession` previously fire-and-forgot each
  keystroke and dropped the frame while the transport was down; it now queues
  per-session bytes (bounded at 256 KB so a runaway paste can't grow memory
  forever), replays them in arrival order on `onopen`, and exposes
  `onPendingInputChange` so the UI can show that the input is held. The mobile
  composer is no longer hard-disabled while disconnected, so the user can keep
  typing; `TerminalView` shows a visible "Will send once reconnected — N
  characters queued" banner so the buffered input reads as held rather than
  vanishing. Builds on the FLO-103 backgrounded-WebSocket reconnect and the
  FLO-108 daemon-down indicator.

- Android app shows an always-visible "ongoing" notification with the
  running-agent count and the top pending "needs you" ask, so a user can
  glance at the notification shade without opening the app (FLO-160). The
  daemon computes a per-owner snapshot on every genuine post-dedup status
  transition and fans it out as a data-only FCM message; the app's new
  `SlipstreamMessagingService` renders it as a non-dismissible, non-alerting
  shade entry that replaces itself on each refresh and cancels when nothing
  is running and nothing needs attention. The snapshot path hangs off
  `pushService.ts`'s existing once-per-episode `transitionKind` dedup (with
  a 500ms per-owner debounce to coalesce same-tick bursts) — never a raw
  `status` subscription — so the notification reflects real episode
  transitions rather than flickering on the idle-TUI status flapping
  documented in CLAUDE.md's status-flap gotcha. iOS tokens are deliberately
  excluded (no ongoing-notification concept there).

- Answer an agent's "needs input" ask straight from the push notification,
  without opening the app, via an inline text-reply field on the
  notification itself (FLO-151). On Android a `needs` transition now fans
  out a data-only FCM message (instead of a notification-bearing one) so
  `SlipstreamMessagingService` can build the notification locally and attach
  a `RemoteInput` reply action; the new `ReplyReceiver` captures the typed
  reply and POSTs it to a new background-capable `POST /inline-reply`
  endpoint — bypassing the WebSocket entirely, since the app/WebView may be
  dead — which reuses `sessions.write` (so the reply also re-arms
  `pushService`'s per-episode notification dedupe via the `input` event).
  The daemon URL + bearer token the receiver needs are synced into a private
  `SharedPreferences` from `nativeStorage` whenever they change. iOS and web
  stay on the existing transport (no reliable inline-reply support — verify,
  don't promise); this is an Android-first prototype. Note: the reply-token
  copy lives in plaintext `MODE_PRIVATE` prefs (within the documented at-rest
  threat model); Keystore-backing it is the production follow-up.

- Isolated per-worktree dev deploy target (TASK-WH96T): `pnpm deploy` from a
  linked git worktree now always deploys to that worktree's own instance
  (own systemd unit `slipstream-dev@<slug>.service`, own port from 7431 up,
  own data dir under `~/.local/share/slipstream-dev/<slug>`, own Tailscale
  HTTPS port from 8443 up) instead of the shared production instance —
  target resolution is structural (git-dir vs git-common-dir), not path
  matching, and is a hard guard that no flag or env var can override from a
  worktree. `pnpm dev:slots` lists every registered dev slot; `pnpm dev:down`
  stops+disables the current worktree's unit, removes its env file, and
  releases its slot.

### Changed

- Production is now protected from worktree deploys by three independent
  layers (TASK-WH96T): `deploy.sh`'s target guard, a PreToolUse hook that
  denies raw `systemctl`/`tailscale`/prod-path bash from a linked worktree,
  and an opt-in bubblewrap sandbox (`SLIPSTREAM_SANDBOX=bwrap`, on by
  default for new dev slots) that hides production's data dir and checkout
  from a sandboxed agent's filesystem view. See
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full division of
  labour between the three.
- `pnpm dev` / `pnpm dev:backend` from a linked worktree now set
  `SLIPSTREAM_DATA_DIR` to that worktree's own dev data dir (TASK-WH96T), so
  a dev session can no longer open production's `slipstream.db`. Behavior
  from the main worktree is unchanged.

## [0.3.1] - 2026-07-24

### Fixed

- Android app rendered the desktop layout (overflowing header, panned-off UI)
  instead of the mobile one. `Plugin.addListener()` became synchronous under
  Capacitor 7 (this app's shipped version) instead of returning a Promise;
  `subscribeWidgetAgentOpen()` still unconditionally chained `.then()` on its
  result, so on Android it threw during `App.svelte`'s `onMount`, aborting
  everything after it — including the `checkViewport()` call that sets the
  `mobile`/`drawer` layout stores. Fixed by accepting both the sync (v7) and
  Promise (v6) return shapes, guarding the call so a native subscription
  failure can never propagate, and moving the viewport setup to the top of
  `onMount` so it can no longer be stranded by a later throw.

## [0.3.0] - 2026-07-23

### Added

- `pnpm release` also builds the versioned debug APK to
  `dist-apk/slipstream-<version>.apk` (best-effort — warns and continues if
  the Android toolchain is absent or `SKIP_APK=1` / `--skip-apk` is passed),
  and prints the Tailscale access URL.
- `pnpm deploy` publishes the newest built APK for download: copied into
  `dist/` as both `slipstream-latest.apk` and the versioned name, with a
  download URL + QR printed, served with the
  `application/vnd.android.package-archive` MIME type.

## [0.2.4] - 2026-07-23

### Fixed

- Hand-off target list (TASK-S870M) no longer forgets a session's current
  agent after a reload or daemon restart. `dtoToSession` was dropping
  `agentKind` when rebuilding the renderer's session store from the backend
  DTO, so a rehydrated session always displayed as if it were still on its
  original agent (usually Claude Code) — hiding that agent from "Hand off"
  (since the UI thought it was already current) while leaving the *actual*
  current agent selectable as a target. Most visible after handing a run off
  from Claude Code to another agent (e.g. Pi) and later trying to hand it
  back once that agent hit its usage limit.

## [0.2.3] - 2026-07-23

### Added

- Android home-screen widget rows now show PR/CI/review chips and an
  estimated cost label when a session has an open PR and/or transcript
  usage (FLO-157), reusing the same chip semantics as Mission Control's
  PR badges and cost pills so the widget can't disagree with the app.
- Android app buzzes once (haptic feedback) when a session flips to "needs
  you" while the app is foregrounded (FLO-161) — re-armed per episode the
  same way the desktop notification is, not a raw status check, so an idle
  TUI's needs/running flap doesn't buzz repeatedly.

## [0.2.2] - 2026-07-23

### Added

- Android app now shows a Nulliel-branded "can't reach the daemon" page
  (TASK-COOXW) instead of the browser's default connection-error page, with
  a one-tap retry and a way to fix a stale server address inline.

## [0.2.1] - 2026-07-23

### Added

- Android home-screen widget (TASK-DM25C): lists running agent sessions
  (title, status, repo) in a scrollable list, color-coded by urgency (needs
  attention / running / done). Renders a local snapshot only — no network
  calls and no auth token on the widget's render path.
- Mobile UX fast lanes (TASK-CQFRV): a reveal-gated "Pair a device" QR
  code/link in Settings > Integrations (reuses the existing `?token=` boot
  path, so scanning it connects a phone with no manual URL/token entry);
  home-screen widget rows now deep-link into the tapped session instead of
  just opening the app; a mobile keyboard quick-key row (Esc, Tab, Ctrl+C,
  history up/down) on the terminal composer; and one-tap yes/no/proceed
  reply chips on Mission Control's "needs you" cards for unambiguous asks.

### Fixed

- `pnpm release`'s failure path (when `[Unreleased]` is empty) now reverts
  `package-lock.json` alongside `package.json` — previously only
  `package.json` was rolled back, leaving the lockfile's embedded version
  bumped and dirty after a failed release attempt.

## [0.2.0] - 2026-07-22

### Added

- Defined and adopted a versioning + release scheme (FLO-147): `package.json`
  version is the semver source of truth, stamped into the desktop app, daemon,
  and pod image at build time and surfaced via `GET /healthz` and the
  diagnostics RPC/UI; the SQLite schema version (`SCHEMA_VERSION` in
  `electron/db/migrations.ts`) is now queryable alongside the app version.
