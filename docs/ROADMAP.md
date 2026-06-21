# Roadmap & status

Living doc: where Flotilla is and where it's going. Update it as phases land.

_Last updated: 2026-06-21._

## Done ✅

**Phase 0 — Scaffold & UI**
- Electron + Vite + Svelte 4 + Tailwind scaffold; pnpm.
- Ported the approved shadcn two-pane UI to components (agent list + terminal,
  idle→configure→start, live theming). `prototype.html` kept as reference.

**Phase 1 — Backend services** (behind `electron/shared/contract.ts`)
- SQLite persistence (`db.ts`, schema inlined).
- `repoRegistry` (validation + idempotent register + remove), `worktreeManager`
  (guarded remove, diff/ahead-behind), `sessionManager` (node-pty), `statusDetector`
  (heuristics), `portBroker` (floo), typed IPC bridge (preload + `registerIpc`).

**Phase 1 — Renderer wiring**
- `window.flotilla` bridge live; repos as a store; backend-driven data on startup.
- Native folder-picker import; real `startSession` (worktree + claude PTY);
  `TerminalView` streams the live PTY (data/input/resize/status); kill + guarded cleanup.

**Repositories & feedback**
- Settings modal with a **Repositories** tab (list / add / remove).
- Toast system (success/error, auto-dismiss); import validation with clear errors.

**Mock removal**
- All mock data deleted; app is real-data-only. New-agent supports a **blank agent**
  (title + prompt, no ticket); ticket picker appears only when a provider supplies tickets.

**Verification**
- 56 tests: `statusDetector` (26), `worktreeManager` pure (18) + real-git integration (5),
  `preload-esm` build guard (1), `claudeTrust` (6).
- Playwright drivers in `scripts/e2e/` exercise add-repo, settings/repos, and blank-agent
  flows against the built app (verified via screenshots).

**Live PTY streaming verified**
- Confirmed end-to-end: Start → real `claude` (PTY) → live xterm streaming, via a manual run.
- Folder-trust dialog removed for autonomous Start: `sessionManager` now pre-seeds
  `hasTrustDialogAccepted` for the worktree dir in `~/.claude.json` (new `claudeTrust.ts`,
  atomic write, best-effort) before spawning, so a fresh worktree no longer prompts.
  Test count is now 56 (6 new `claudeTrust` unit tests).

**Headless web mode**
- WS server (`pnpm serve`, `FLOTILLA_TOKEN`-gated) + `wsApi` client so the same UI runs
  in a browser/mobile against a remote backend.

**Early-output buffer**
- Authoritative bounded per-session `OutputBuffer` in `sessionManager` (last 256 KB +
  monotonic `seq`). Consumers replay on attach (subscribe-first → `getSessionBuffer` →
  write backlog → flush live chunks with `seq` past the snapshot), so the first PTY bytes
  and mid-session web joins lose nothing. Exact dedup: PTY chunks emit atomically, so each
  is wholly before or after the snapshot. +8 `OutputBuffer` unit tests (103 total).

**Real ticket provider — Linear**
- `linearProvider` (behind `ITicketProvider`) replaces `emptyProvider`. Personal API key
  entered in a new Settings → **Integrations** tab, persisted in a SQLite `config` table
  (`configStore`); the provider reads it lazily and queries Linear's GraphQL over `fetch`
  (no new dependency). The query returns issues assigned to the viewer **or** unassigned,
  excluding completed/canceled. The New-agent picker re-fetches on dialog open (was
  startup-only). Verified end-to-end against a real workspace. +6 `linearProvider` tests
  (109 total).

## Next 🔜

1. **Status-detection hardening** — tune `statusDetector` against real `claude` TUI output
   (the "needs you" patterns are coarse stubs today).
2. **Jira ticket provider** — second `ITicketProvider` alongside Linear, if needed.

## Later 🗓️

- **Session persistence/restore** across app restart (metadata is stored; PTYs currently
  die with the app).
- **Packaging** with electron-builder (Linux first).
- **Background daemon** so agents keep running with the UI closed and reattach on reopen.
- **floo** UX: surface the assigned port in the UI; confirm env injection.
