# CLAUDE.md

Notes for Claude Code (and humans) working in this repo. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md) first.

## Commands

```sh
pnpm dev        # Vite + Electron (auto-opens DevTools in dev)
pnpm build      # renderer + electron main + preload
pnpm test       # vitest (unit + real-git integration)
pnpm check      # svelte-check typecheck (run before committing)
```

Always run `pnpm check` and `pnpm test` before committing. Use **pnpm** (not npm/yarn).

## Conventions

- **The contract is the seam.** `electron/shared/contract.ts` defines all DTOs, service
  interfaces, IPC channels, and `FlotillaApi`. Implement against it; coordinate any change
  to it. Services never import each other — they're wired only in `electron/main.ts`.
- **Guard backend calls** in the renderer with `hasBackend` (from `src/lib/ipc.ts`) so the
  UI still runs in a plain browser for design work.
- **No mock data.** The app is real-data-only; ticket sources go behind `ITicketProvider`.
- **Svelte 4** (legacy stores, `$store`, `on:click`). Reuse the shadcn classes/tokens in
  `src/app.css`; prefer them over ad-hoc styles.
- Parallelizable work splits cleanly along `electron/` vs `src/` (disjoint dirs).

## Gotchas (hard-won)

- **ESM preload**: `preload.ts` builds to `preload.mjs`. It only loads with
  `sandbox: false` (set in `main.ts`) **and** ESM output — `vite.config.ts` forces
  `output.format: 'es'`. Symptom if broken: `window.flotilla` is `undefined`,
  `Add repo`/everything silently no-ops (falls back to mock-less empty state).
- **Bundled main has no sibling files.** Anything `main.js` needs at runtime must be
  inlined or bundled — e.g. the DB schema is a `SCHEMA` string in `db.ts`, not a `.sql`
  file (which the bundler won't copy). Symptom if broken: `No handler registered for ...`
  because `openDb` threw before `registerIpc` ran.
- **Native modules** (`node-pty`, `better-sqlite3`) are built for **Electron's ABI**, so
  node-run tests can't import `db.ts`/`sessionManager.ts`. Tests cover pure logic +
  real-git integration instead.
- **vitest uses `vitest.config.ts`** (not the Vite config) so tests don't run through the
  Electron plugin (which rewrites `child_process` into a require-shim that breaks ESM).

## Troubleshooting native setup

pnpm 10 defers build scripts; they're allowlisted via `pnpm.onlyBuiltDependencies` in
`package.json`. On a fresh/odd machine:

```sh
pnpm rebuild esbuild electron better-sqlite3 node-pty   # run native build scripts
# Electron binary "failed to install": its postinstall didn't extract the zip —
node node_modules/electron/install.js                   # re-run; if extract fails, unzip
# the cached ~/.cache/electron/<hash>/electron-*.zip into node_modules/electron/dist/
# and write "electron" to node_modules/electron/path.txt
pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty   # match Electron ABI
```

## e2e drivers

`scripts/e2e/*.mjs` launch the **built** app via Playwright in an isolated
`--user-data-dir`, stub the native folder dialog, drive a flow, and screenshot to `/tmp`.
They require a display (not headless). Build first (`pnpm build`), then
`node scripts/e2e/<flow>.mjs`. Do **not** drive `Start agent` with a real repo unless you
intend to spawn an autonomous `claude`.
