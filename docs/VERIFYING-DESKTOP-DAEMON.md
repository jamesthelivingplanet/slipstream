# Verifying the desktop-as-thin-client daemon

How to manually verify that the desktop app drives sessions over WebSocket to a local (or
remote) daemon, that the daemon survives app-close, and that the existing e2e flows still pass.
Introduced with FLO-47 (P7/D2). See [ARCHITECTURE.md](ARCHITECTURE.md) for the process model.

The automated gates run with `pnpm check` (svelte-check), `pnpm test` (unit + integration, incl.
the `daemonManager` and `preload-esm` guards), and `pnpm build`. Everything below covers the
parts that require launching the real app.

## 0. Prerequisite — rebuild natives for Electron's ABI

If `node_modules` was installed/rebuilt against plain Node (not Electron), rebuild the natives
before launching, or the daemon throws in `openDb()`:

```sh
pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty
```

Symptom if skipped: `better_sqlite3.node … compiled against … NODE_MODULE_VERSION 127 …
requires 130`, then `No handler registered for …`.

## 1. Desktop drives sessions over WS to a local daemon

```sh
pnpm build
npx electron .        # or: pnpm dev
```

Confirm the thin-client wiring — in the app's DevTools console:

- `window.__slipstreamDaemon` → `{ url: "ws://127.0.0.1:<port>/rpc", token: "…" }`
- `window.slipstream` is defined (the WS API, not the old in-process preload bridge)

Confirm the daemon is a real, separate process:

```sh
curl -s http://127.0.0.1:7421/healthz        # → {"ok":true}   (port from <dataDir>/daemon.json)
ss -ltnp | grep 7421                          # daemon listening
pgrep -af server.js                           # the ELECTRON_RUN_AS_NODE child
```

Add a repo and start an agent; the terminal should stream. That traffic now flows over the
WebSocket — the same path the browser uses.

## 2. Closing the UI leaves agents running

With an agent running, close the desktop window, then:

```sh
curl -s http://127.0.0.1:7421/healthz   # still {"ok":true} — daemon survived
pgrep -af claude                          # the agent PTY is still alive
```

Reopen the app (`npx electron .`). The session reappears as still-running and replays its
buffered output. The daemon was *reused*, not respawned — the `daemon.json` port is unchanged.

## 3. Remote daemon works identically

Run a daemon yourself, then point the desktop at it instead of spawning a local one:

```sh
# terminal A — a "remote" daemon
SLIPSTREAM_TOKEN=secret SLIPSTREAM_PORT=8000 pnpm serve

# terminal B — desktop as a thin client of it
SLIPSTREAM_DAEMON_URL=http://127.0.0.1:8000 SLIPSTREAM_TOKEN=secret npx electron .
```

Confirm `window.__slipstreamDaemon.url` is `ws://127.0.0.1:8000/rpc` and that **no local daemon
was spawned** (`pgrep -af server.js` shows only the one you started in terminal A). Sessions you
create appear in terminal A's daemon. This is the same code path used to connect to a real pod
over a Tailscale tailnet.

## 4. Existing e2e flows pass against the new path

These require a display (not headless) and the built app:

```sh
pnpm build
node scripts/e2e/add-repo-flow.mjs
node scripts/e2e/settings-repos-flow.mjs
node scripts/e2e/new-agent-flow.mjs
node scripts/e2e/persist-restart-flow.mjs     # restart-restore still works
node scripts/e2e/daemon-survival-flow.mjs     # proves survival + reuse
```

Every driver launches with `SLIPSTREAM_DAEMON_EPHEMERAL=1` so its daemon dies on `app.close()`
(no orphans). The exception is `daemon-survival-flow.mjs`, which omits the flag on purpose and so
leaves a daemon running — kill it afterward:

```sh
fuser -k 7421/tcp     # or: kill the pid from `pgrep -af server.js`
```

## Resetting state

The daemon survives app-close by design, so quitting the app does not reset anything. To fully
reset (free the port, drop live sessions, pick up rebuilt daemon code), kill the daemon process
that holds the `<dataDir>/daemon.json` port, or launch with `SLIPSTREAM_DAEMON_EPHEMERAL=1`.
