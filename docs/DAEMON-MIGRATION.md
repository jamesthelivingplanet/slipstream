# Daemon migration

> This is a placeholder stub — to be fleshed out.

## Current state

PTY sessions live in whichever process spawned them (the Electron main process or the headless `pnpm serve` server). Only session **metadata** (`SessionDTO`) is persisted to SQLite via `sessionStore`; the PTY processes themselves die with the app. The standalone server and the desktop app do **not** share live sessions.

See the ["Session locality"](ARCHITECTURE.md#session-locality) section of Architecture for details.

## Planned: background daemon

The goal is to move to a **background daemon** model where:

1. A single long-lived daemon process owns all PTY sessions.
2. The Electron desktop app and any browser clients become **thin clients** that attach to the daemon.
3. Closing the UI does **not** kill running agents — they keep running in the daemon.
4. Reopening the UI re-attaches to the live sessions.

This is the "Background daemon" item in the ["Later"](ROADMAP.md#later-️) section of the Roadmap.

`attachRemoteControl` (spawning claude with `--remote-control`) is a precursor to this model — it already demonstrates re-attaching a UI to a live agent session.
