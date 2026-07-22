# Versioning + release scheme

Slipstream ships three runtime shapes of the same codebase — the Electron
desktop app, the headless daemon (`pnpm serve`), and the pod Docker image
(which runs the same daemon build as `node dist-electron/server.js`) — plus a
SQLite schema that evolves independently underneath all three. This doc is the
one place the scheme is defined so it isn't re-litigated per release.

## Scheme: semver, `package.json` is the source of truth

Slipstream follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking changes to the wire protocol (`electron/shared/wire.ts`),
  the `SlipstreamApi` contract (`electron/shared/contract.ts`), or anything
  that requires a coordinated desktop+daemon upgrade (not just "restart the
  daemon and reload").
- **MINOR** — new features, new DB migrations (see below), non-breaking
  contract additions.
- **PATCH** — bug fixes, no schema change, no contract change.

The single source of truth is the `version` field in `package.json` at the
repo root. Nothing else declares a version independently — every surface
below derives from it at build time.

## Surfacing: how to check what's running

- **`GET /healthz`** (daemon and pod — same endpoint, same handler in
  `electron/server/server.ts`) returns:
  ```json
  { "ok": true, "version": "0.1.0", "gitSha": "abc1234", "schema": 8 }
  ```
- **The diagnostics RPC** (`IPC.getDiagnostics`, `electron/core/rpc.ts`)
  returns the same three fields under `versions.app` / `versions.gitSha` /
  `versions.schema`, alongside the existing Node/Electron/V8/Chrome runtime
  versions. This is what powers the Settings → Diagnostics panel in the
  desktop/web UI, which shows both the UI bundle's own build (`App` row,
  stamped into the renderer directly) and the daemon's reported build
  (`Daemon` row) side by side — useful for spotting a stale daemon after an
  update.
- **The renderer's own build** is stamped separately (`__APP_VERSION__` /
  `__APP_GIT_HASH__`, see Build stamping below) and shown in Settings → About
  and Settings → Diagnostics regardless of whether a daemon is reachable.

## Schema/data versioning

The SQLite schema is versioned independently of the app's semver, via
SQLite's built-in `PRAGMA user_version` (see `electron/db/migrations.ts`).
Each entry in the `MIGRATIONS` array migrates the DB from `user_version i` to
`i+1`; `runMigrations` applies whichever migrations are newer than the DB's
current `user_version`, atomically, on every `openDb()` call. `SCHEMA_VERSION`
(`MIGRATIONS.length`) is the schema version a given build expects, and is what
gets surfaced via `/healthz` and diagnostics.

This is deliberately **not** a 1:1 mapping to the app's semver — a fresh
checkout's DB self-heals to the latest schema on next open regardless of which
app version last touched it, and multiple app releases can share a schema
version if none of them touched the DB shape. The convention is:

- Adding a migration (bumping `SCHEMA_VERSION`) is at least a **minor** app
  version bump, since it changes on-disk shape new clients can read that old
  clients may not fully understand (even though old clients won't crash — the
  migration runner never removes columns old code doesn't use).
- Migrations are additive-only and never edited after being merged (see the
  RULES comment at the top of `migrations.ts`) — a released migration is
  immutable; new schema changes always append a new migration function.
- There is no separate "schema version" to bump by hand — it's derived
  (`MIGRATIONS.length`), so it's impossible for it to drift from what the
  running code actually applies.

## Build stamping

`__APP_VERSION__` / `__APP_GIT_HASH__` are build-time constants substituted by
each bundler's `define`, all sourced from the same helper
(`scripts/lib/buildMeta.mjs`, reading `package.json` + `git rev-parse --short
HEAD`) so there's exactly one computation to keep in sync:

- `vite.config.ts` — renderer (`src/`) and the Electron main process build.
- `scripts/build-server.mjs` — the daemon bundle (`dist-electron/server.js`),
  which is what both the Electron app spawns as a child process and what the
  pod Docker image runs directly. Stamping this one bundle covers both.
- `vitest.config.ts` — so tests exercising daemon code that reads these
  constants (e.g. hitting `/healthz`) see real values instead of `undefined`.

`electron/shared/version.ts` exports `APP_VERSION` / `GIT_SHA`, guarded with
`typeof` checks that degrade to `'unknown'` in any bundle that doesn't inject
the define, rather than throwing — this is the one place daemon code should
import these from (`electron/core/rpc.ts`, `electron/server/server.ts`).

`GIT_SHA` env var (checked before shelling out to `git rev-parse`) is how the
Docker build gets a real SHA despite `.git` being excluded from the build
context (`.dockerignore`) — the `Dockerfile` declares `ARG GIT_SHA=unknown` /
`ENV GIT_SHA=$GIT_SHA`, and CI's `publish-image` job in `.gitlab-ci.yml` passes
`--build-arg GIT_SHA="$CI_COMMIT_SHORT_SHA"`. A local `docker compose up
--build` without that arg falls back to `unknown` for gitSha (the `version`
field is still correct, since that comes from `package.json`, which IS in the
build context).

## Tagging + changelog

Cut a release with:

```sh
pnpm release          # minor bump (default)
pnpm release patch
pnpm release minor
pnpm release major
```

`scripts/release.sh` does the whole flow mechanically:

1. Refuses to run anywhere but `master`, with an unclean working tree, or on
   a `master` that's behind `origin/master`.
2. Runs the quality gates (`pnpm check`, `pnpm test`, `pnpm lint`) —
   `SKIP_CHECKS=1 pnpm release` skips this.
3. Bumps `version` in `package.json` per the semver rules above
   (`npm version <bump> --no-git-tag-version`).
4. Moves `CHANGELOG.md`'s `## [Unreleased]` section into a new
   `## [X.Y.Z] - YYYY-MM-DD` section (format:
   [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) via
   `scripts/bumpChangelog.mjs`, leaving a fresh empty `## [Unreleased]`
   above it. Refuses to proceed (and reverts the version bump) if
   `[Unreleased]` has nothing in it — add a changelog entry before releasing.
5. Commits `package.json` + `CHANGELOG.md` as `Release vX.Y.Z`.
6. Tags the commit `vX.Y.Z` (annotated) and pushes both `master` and the tag.

This only versions and tags a commit — it doesn't deploy anything. Run
`pnpm deploy` separately to update a running service to the new version.

`.gitlab-ci.yml`'s `publish-image` job already publishes
`$CI_REGISTRY_IMAGE:latest` and `:$CI_COMMIT_SHORT_SHA` on every merge to
`master` as a rolling/debug tag; the `vX.Y.Z` git tag is the durable,
human-meaningful release marker and changelog anchor — it is not currently
wired to an additional CI-published image tag (that's a reasonable future
addition if a pinned `:vX.Y.Z` image tag becomes useful, but isn't required
for the version-identity story this doc covers).
