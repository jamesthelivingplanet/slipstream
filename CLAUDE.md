# CLAUDE.md

Hard-won, non-obvious notes for this repo — start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

Use **pnpm**. Run `pnpm check` (svelte-check) and `pnpm test` before committing. `pnpm deploy`
builds, then restarts the systemd `slipstream.service` and hits a healthz check.

## Conventions

- **The contract is the seam.** `electron/shared/contract.ts` defines all DTOs, service
  interfaces, IPC channels, and `SlipstreamApi`. Implement against it; coordinate any change
  to it. Services never import each other — they're wired only in `electron/main.ts`.
- **Guard backend calls** in the renderer with `hasBackend` (from `src/lib/ipc.ts`) so the
  UI still runs in a plain browser for design work.
- **No mock data.** The app is real-data-only; ticket sources go behind `ITicketProvider`.
- **Svelte 4** (legacy stores, `$store`, `on:click`) — not Svelte 5. Reuse the shadcn
  classes/tokens in `src/app.css` over ad-hoc styles.
- Parallelizable work splits cleanly along `electron/` vs `src/` (disjoint dirs).

## Gotchas (hard-won)

- **ESM preload**: `preload.ts` builds to `preload.mjs`. It only loads with
  `sandbox: false` (set in `main.ts`) **and** ESM output — `vite.config.ts` forces
  `output.format: 'es'`. Symptom if broken: `window.slipstream` is `undefined`,
  `Add repo`/everything silently no-ops (falls back to mock-less empty state).
- **Bundled main has no sibling files.** Anything `main.js` needs at runtime must be
  inlined or bundled — e.g. the DB schema is a `SCHEMA` string in `db.ts`, not a `.sql`
  file (which the bundler won't copy). Symptom if broken: `No handler registered for ...`
  because `openDb` threw before `registerIpc` ran.
- **Native modules** (`node-pty`, `better-sqlite3`) are built for **Electron's ABI**, so
  node-run tests can't import `db.ts`/`sessionManager.ts`. Tests cover pure logic +
  real-git integration instead.
- **Rebuild natives for Electron, not Node.** `pnpm rebuild better-sqlite3 node-pty` — and
  any change to the Node version pnpm runs scripts on (e.g. `devEngines.runtime` in
  `package.json`) — compiles them against the *current Node's* ABI, which Electron then
  refuses to load. Symptom: `better_sqlite3.node … compiled against … NODE_MODULE_VERSION
  127 … requires 130` (127 = Node 22, 130 = Electron 33). That throw happens in `openDb()`,
  so `registerIpc()` never runs → `No handler registered for 'repos:list'`. Always finish a
  native rebuild with `pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty`.
- **vitest uses `vitest.config.ts`** (not the Vite config) so tests don't run through the
  Electron plugin (which rewrites `child_process` into a require-shim that breaks ESM).
- **`ELECTRON_RUN_AS_NODE` + native ABI**: `pnpm serve` runs
  `ELECTRON_RUN_AS_NODE=1 electron dist-electron/server.js`. This reuses Electron's Node
  binary so `better-sqlite3` and `node-pty` (built for Electron's ABI) load without a
  separate rebuild. In `ELECTRON_RUN_AS_NODE` mode the Electron `app` API is unavailable
  — which is why `resolveDataDir()` in `electron/core/services.ts` derives the data path
  from `os.homedir()` / env vars rather than `app.getPath('userData')`.
- **`window.slipstream` must be set before `App`/`ipc.ts` loads**: in web mode `src/main.ts`
  assigns `window.slipstream` and `window.__slipstreamWeb = true` and only _then_ does
  `await import('./App.svelte')`. This is intentional — `ipc.ts` has a module-level
  `hasBackend = !!window.slipstream`. If App is imported first (or the order changes),
  `hasBackend` is `false` and all backend calls silently no-op.
- **`SLIPSTREAM_TOKEN` is required**: the headless server (`pnpm serve`) refuses to start if
  the env var is unset. Without it there is no authentication on the WebSocket endpoint.

## Troubleshooting native setup

pnpm 11 no longer reads the `pnpm` field in `package.json`; the build-script allowlist lives
in `pnpm-workspace.yaml` under `allowBuilds:` (a map of `pkg: true`). On a fresh/odd machine:

```sh
pnpm rebuild esbuild electron better-sqlite3 node-pty   # run native build scripts
# Electron binary "failed to install": its postinstall didn't extract the zip. On Node 24,
# install.js can exit mid-extraction (leaving only dist/locales) — pin Node 22 or, failing
# that, manually unzip the cached ~/.cache/electron/<hash>/electron-*.zip into
# node_modules/electron/dist/ and write "electron" to node_modules/electron/path.txt
node node_modules/electron/install.js                   # re-run; if it no-ops, unzip manually
pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty   # match Electron ABI
```

## e2e drivers

`scripts/e2e/*.mjs` launch the **built** app via Playwright in an isolated
`--user-data-dir`, stub the native folder dialog, drive a flow, and screenshot to `/tmp`.
They require a display (not headless). Build first (`pnpm build`), then
`node scripts/e2e/<flow>.mjs`. Do **not** drive `Start agent` with a real repo unless you
intend to spawn an autonomous `claude`.
