# Native modules

`better-sqlite3` and `node-pty` are native modules compiled against a specific
Node/Electron ABI. Most "it silently doesn't work" pain in this repo traces back
to an ABI mismatch. Read this when a native build fails, when switching Node
versions, or when `openDb()` / `sessionManager` throw at startup.

The always-on summary lives in [../CLAUDE.md](../CLAUDE.md); this is the
pull-on-demand detail.

## They're built for Electron's ABI, not Node's

`better-sqlite3` and `node-pty` are built for **Electron's ABI**, so node-run
tests can't import `db.ts` / `sessionManager.ts`. The test suite covers pure
logic + real-git integration instead — it deliberately never loads the
native-backed modules.

## Rebuild for Electron, not Node

`pnpm rebuild better-sqlite3 node-pty` — and any change to the Node version pnpm
runs scripts on (e.g. switching Node via `mise`/`nvm`) — compiles them against
the *current Node's* ABI, which Electron then refuses to load.

Symptom: `better_sqlite3.node … compiled against … NODE_MODULE_VERSION 127 …
requires 130` (127 = Node 22, 130 = Electron 33). That throw happens in
`openDb()`, so `registerIpc()` never runs → `No handler registered for
'repos:list'`.

Always finish a native rebuild with:

```sh
pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty
```

## `ELECTRON_RUN_AS_NODE` reuses Electron's ABI

`pnpm serve` runs `ELECTRON_RUN_AS_NODE=1 electron dist-electron/server.js`.
This reuses Electron's Node binary so `better-sqlite3` and `node-pty` (built for
Electron's ABI) load without a separate rebuild. In `ELECTRON_RUN_AS_NODE` mode
the Electron `app` API is unavailable — which is why `resolveDataDir()` in
`electron/core/services.ts` derives the data path from `os.homedir()` / env vars
rather than `app.getPath('userData')`.

## Fresh / odd machine troubleshooting

pnpm 11 no longer reads the `pnpm` field in `package.json`; the build-script
allowlist lives in `pnpm-workspace.yaml` under `allowBuilds:` (a map of
`pkg: true`). On a fresh/odd machine:

```sh
pnpm rebuild esbuild electron better-sqlite3 node-pty   # run native build scripts
# Electron binary "failed to install": its postinstall didn't extract the zip. On Node 24,
# install.js can exit mid-extraction (leaving only dist/locales) — pin Node 22 or, failing
# that, manually unzip the cached ~/.cache/electron/<hash>/electron-*.zip into
# node_modules/electron/dist/ and write "electron" to node_modules/electron/path.txt
node node_modules/electron/install.js                   # re-run; if it no-ops, unzip manually
pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty   # match Electron ABI
```
