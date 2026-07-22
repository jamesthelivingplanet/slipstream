# CLAUDE.md

Hard-won, non-obvious notes for this repo — start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Reference docs are pull-on-demand:
native build pain → [docs/NATIVE-MODULES.md](docs/NATIVE-MODULES.md); the dev
loop (daemon rebuild, tests, logs, e2e) → [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md);
the auth/secrets threat model → [docs/SECURITY.md](docs/SECURITY.md); the
multi-user identity seam → [docs/IDENTITY-SEAM.md](docs/IDENTITY-SEAM.md); the
versioning/release scheme (semver, build stamping, schema-vs-app version,
tag/changelog flow) → [docs/VERSIONING.md](docs/VERSIONING.md).

Use **pnpm**. Run `pnpm check` (svelte-check), `pnpm test`, and `pnpm lint` (eslint +
`prettier --check`) before committing — `pnpm lint` gates the MR, so don't skip it; use
`pnpm lint:fix` to auto-fix formatting. `pnpm deploy` builds, then restarts the systemd
`slipstream.service` and hits a healthz check. Master takes frequent MR merges: `git pull
--rebase origin master` right before pushing, and expect the conflict (if any) in
`contract.ts` — every feature extends it, so additive changes collide there.

If a change touches `scripts/setup.sh`, `scripts/deploy.sh`, `package.json` (scripts/engines),
or how the app is bootstrapped/deployed, check whether `.claude/skills/setup/SKILL.md` still
describes the current behavior and update it in the same change.

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

Each is a tripwire — the symptom is here, the full procedure is in the linked doc. Pull the
doc only when the symptom matches what you're seeing.

- **CJS preload**: `preload.ts` builds to `preload.cjs` (`vite.config.ts` forces
  `output.format:'cjs'` + `[name].cjs`), so the `BrowserWindow` can run `sandbox: true`.
  Symptom if broken: `window.slipstream` is `undefined` and `Add repo`/everything silently
  no-ops. Why (sandbox rationale) is in the preload ⚠️ block of
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the build guard is
  `scripts/check-preload-cjs.mjs` (asserts no top-level ESM in the output; run in the CI
  `build` job and `deploy.sh` phase 2).
- **Bundled main has no sibling files.** Anything `main.js` needs at runtime must be inlined
  or bundled — e.g. the DB schema is a `SCHEMA` string in `db.ts`, not a `.sql` file (which
  the bundler won't copy). Symptom if broken: `No handler registered for ...` because
  `openDb` threw before `registerIpc` ran.
- **Native ABI**: `better-sqlite3`/`node-pty` are built for **Electron's** ABI, not Node's;
  a wrong-ABI load throws in `openDb()` → `No handler registered for 'repos:list'`. Rebuild +
  fresh-machine troubleshooting: [docs/NATIVE-MODULES.md](docs/NATIVE-MODULES.md).
- **`window.slipstream` must be set before `App`/`ipc.ts` loads.** `src/main.ts` assigns
  `window.slipstream` (and `__slipstreamWeb`) and only _then_ does `await import('./App.svelte')`
  — `ipc.ts` has a module-level `hasBackend = !!window.slipstream`. Import App first (or change
  the order) and all backend calls silently no-op.
- **`--slipstream-daemon=` arg**: `main.ts` passes daemon URL+token to the renderer via
  `additionalArguments: ['--slipstream-daemon=<base64>']`; the preload parses `process.argv`
  (not `ipcRenderer`) into `window.__slipstreamDaemon`. If absent, the app falls back to web
  mode → `window.slipstream` undefined, backend calls silently no-op.
- **`SLIPSTREAM_TOKEN` is required**: the headless server (`pnpm serve`) refuses to start if
  unset — without it there is no auth on the WebSocket endpoint.
- **Backend edits don't hot-reload.** `pnpm dev` builds `server.js` once and reuses the daemon;
  edit `server.ts` / `electron/services/*` / `electron/core/*` and you must rebuild + restart
  the daemon — use `pnpm dev:backend`. Full cycle + reset procedure:
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
- **Red "errored" bubble?** Read `<dataDir>/logs/<sessionId>.log` first (exit code + last 2KB
  of PTY output). Detail: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §Debugging.
- **Repo paths self-heal, but only so far**: `repoResolve.ts` re-validates the stored path on
  use and self-heals a moved/renamed repo via its `origin` remote URL. If no sibling checkout
  matches (deleted, or a fresh pod that hasn't cloned it) the run fails deep in
  `worktrees.create` with just the red bubble — register by remote URL (`registerRepoByUrl`)
  instead.
- **Identity seam (`ownerId`)**: every RPC carries a resolved `Identity` — the static
  `SLIPSTREAM_TOKEN` still resolves to `{ id:'local' }`, but any other bearer token is now
  looked up in the per-device/per-user store (`electron/services/deviceTokenStore.ts`,
  FLO-143) via `resolveIdentity()` (`electron/core/auth.ts`); `createRpc` filters
  enumerations and guards reads by `ownerId`. Don't add a read of a `sessions`/`repos` row
  without scoping it by owner. See [docs/IDENTITY-SEAM.md](docs/IDENTITY-SEAM.md).
- **Secrets at rest**: config-table secrets are `safeStorage`-encrypted (`ss1:`) on
  desktop and AES-256-GCM-encrypted (`sk1:`, key from `SLIPSTREAM_SECRET` or a
  file-backed `<dataDir>/secret.key`) on the daemon/headless server (FLO-145). Reads
  are marker-transparent; a value the process can't decrypt reads as absent, never
  raw ciphertext. Does not defend against a same-uid reader. Detail:
  [docs/SECURITY.md](docs/SECURITY.md) §6.
- **Session status flaps by design — never time-window dedupe a status consumer.** The
  `status` event fires on every PTY chunk (not on change), and on an idle TUI the heuristic
  status ping-pongs `needs`↔`running` every few seconds (repaints reset the idle clock).
  Symptom: whatever reacts to a transition (notifications, GC, write-backs) fires over and
  over. React **once per episode**, re-armed by the `input` event (real user keystrokes) —
  `pushService.ts` is the reference. Pipeline + producer rules:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §Session status pipeline.
- **The agent status contract's factual surface is single-sourced in
  `electron/shared/slipstreamCommands.ts`** — the command list, exit codes, and the
  "state is reported ONLY through the `slipstream` CLI" claim live there once, and the
  three doc surfaces render from it: `promptComposer.ts` (system prompt) +
  `cliSkillDoc.ts` (the `slipstream` worktree skill) + `electron/cli/slipstream.ts`
  (usage text + per-command stdout nudges). Adding/renaming a command or changing an
  exit code is a one-line edit to `SLIPSTREAM_COMMANDS`/`EXIT_CODES` and every surface
  (and the tests that iterate them) updates. What is NOT unified — and still ripples —
  is the persuasive per-audience *prose* (the resume-from-waiting coaching, etc.),
  which is hand-written in each file and pinned by substring in
  `promptComposer.test.ts`/`slipstream.test.ts`/`cliSkillDoc.test.ts` (+ the spec's own
  `slipstreamCommands.test.ts` cross-surface agreement tests). The sentinel consumers
  (`statusDetector.ts`/`statusSentinel.ts`/`agentEventsSentinel.ts`) are unchanged.
  Detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §Session status pipeline.
