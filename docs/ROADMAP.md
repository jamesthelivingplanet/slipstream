# Roadmap & status

Living doc: where Flotilla is and where it's going. Update it as phases land.

_Last updated: 2026-05-31._

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

## Next 🔜

1. **Early-output buffer** — the first PTY bytes can race the terminal's subscription;
   buffer-and-replay in `sessionManager` so nothing is lost.
2. **Real ticket provider** — Linear and/or Jira behind `ITicketProvider` (replacing
   `emptyProvider`); the New-agent ticket picker is already wired for when tickets exist.
3. **Status-detection hardening** — tune `statusDetector` against real `claude` TUI output
   (the "needs you" patterns are coarse stubs today).

## Later 🗓️

- **Session persistence/restore** across app restart (metadata is stored; PTYs currently
  die with the app).
- **Packaging** with electron-builder (Linux first).
- **Background daemon** so agents keep running with the UI closed and reattach on reopen.
- **floo** UX: surface the assigned port in the UI; confirm env injection.
