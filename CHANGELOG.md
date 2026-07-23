# Changelog

All notable changes to Slipstream are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/) — see
[docs/VERSIONING.md](docs/VERSIONING.md) for how the scheme maps to this repo
specifically (schema versioning, build stamping, release flow).

## [Unreleased]

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
