# Changelog

All notable changes to Slipstream are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/) — see
[docs/VERSIONING.md](docs/VERSIONING.md) for how the scheme maps to this repo
specifically (schema versioning, build stamping, release flow).

## [Unreleased]

## [0.2.0] - 2026-07-22

### Added

- Defined and adopted a versioning + release scheme (FLO-147): `package.json`
  version is the semver source of truth, stamped into the desktop app, daemon,
  and pod image at build time and surfaced via `GET /healthz` and the
  diagnostics RPC/UI; the SQLite schema version (`SCHEMA_VERSION` in
  `electron/db/migrations.ts`) is now queryable alongside the app version.
