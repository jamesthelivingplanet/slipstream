# Changelog

All notable changes to Slipstream are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/) — see
[docs/VERSIONING.md](docs/VERSIONING.md) for how the scheme maps to this repo
specifically (schema versioning, build stamping, release flow).

## [Unreleased]

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
