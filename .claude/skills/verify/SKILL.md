---
name: verify
description: Drive the built Slipstream app end-to-end to observe a change working — headless daemon + Playwright Chromium in web mode, with a stub `claude` on PATH so no real agent spawns. Use when verifying UI/PTY/session changes at runtime instead of via tests.
---

# Verifying Slipstream changes at runtime

The reliable local surface is **web mode** (headless daemon + Chromium via the
repo's own Playwright). The Electron desktop shell may fail to launch on this
machine with `TypeError: Cannot read properties of undefined (reading 'exports')`
from Node's ESM loader — even a minimal ESM main importing `electron` fails —
so don't burn time on `scripts/e2e/*.mjs` if that error appears; go web mode.

## Recipe

1. Build: `pnpm build`. If Electron won't even start apps, rebuild natives:
   `pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty`.
2. Stub the agent so no real `claude` spawns: put an executable `claude` shell
   script first on PATH (print a banner, then `while IFS= read -r line; do echo
   "echo:$line"; done` — the PTY echoes typed chars, the loop proves writes land).
3. Start the daemon isolated (never touch the real instance on 7421):
   `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron dist-electron/server.js`
   with env `SLIPSTREAM_TOKEN=<any>`, `SLIPSTREAM_PORT=<free port>`,
   `SLIPSTREAM_DATA_DIR=$(mktemp -d)`, and the stub dir prepended to `PATH`.
4. Browser: `createRequire(<repo>/package.json)` then `require('playwright')`
   — binaries are cached in `~/.cache/ms-playwright`. Open
   `http://127.0.0.1:<port>/?token=<token>`.
5. Repo: make a throwaway git repo (`git init -b main`, one commit, add an
   `origin` remote URL **and** `git update-ref refs/remotes/origin/main HEAD &&
   git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`), then
   register it from the page: `window.slipstream.registerRepo(path)` — and
   **reload the page** (the renderer's repo store loads at boot only).
6. Drive New agent: `#dTitle`, `#dPrompt`, `#dlgRepoSel .sel-trigger` — but the
   opened dropdown is **portaled to `<body>`** by `floatingAnchor`, so click
   `.sel-menu .opt` unscoped. Start agent spawns the PTY running the stub.
7. Observe: `.term-mount .xterm` for mount;
   `document.querySelector('.term-mount').textContent` for what actually
   painted; `window.slipstream.getSessionBuffer(id)` (id from
   `window.slipstream.listSessions()`) for backend truth. Capture `pageerror`
   events — Svelte init crashes surface there, not in the DOM.
8. Mobile: a 390×844 viewport page. The agent list is an off-canvas drawer —
   open via `button[aria-label="Toggle agent list"]`. The PTY composer is
   `.term-input input`; type + Enter, then assert the stub's `echo:` line
   appears in the session buffer.

## Clean up afterwards

- Kill the daemon; remove the temp data dir and throwaway repo.
- Starting an agent creates `~/.worktrees/<org>-<name>/` — delete it.
- Session start writes a trust entry into `~/.claude.json`
  (`projects[<worktree>]`) — remove entries for the throwaway repo.
