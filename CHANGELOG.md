# Changelog

All notable changes to Slipstream are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/) — see
[docs/VERSIONING.md](docs/VERSIONING.md) for how the scheme maps to this repo
specifically (schema versioning, build stamping, release flow).

## [Unreleased]

### Added

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
