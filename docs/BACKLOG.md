# Development Backlog — Ordered

_Ordered for execution. Each ticket is PR-sized and individually shippable; dependencies are
noted. Phases map to `DAEMON-MIGRATION.md` and the code-health pass. 2026-06-28._

Legend: **P** = priority slot (do in order) · deps = must-land-first.

---

## Phase 0 — Foundation (zero-regret; do before heavy branching)

### P1 — Repo hygiene: prune stale worktrees & ignore tooling exhaust
**Why:** 6 stale `agent-*` worktrees point at the dead `flotilla` path and litter every
search; `.claude/tdd-guard/` is uncommitted tooling data that already leaked into history
("test artifact" commit).
**Scope:**
- `git worktree remove --force` the 6 stale `flotilla` worktrees.
- Add `.claude/tdd-guard/` (and any tdd-guard data dirs) to `.gitignore`.
- Confirm nothing else tooling-generated is tracked.
**Acceptance:** `git worktree list` shows only real worktrees; `git status` clean; `pnpm test`
still green.
**Deps:** none. **Size:** XS.

### P2 — Reconcile architecture docs with current contract
**Why:** `ARCHITECTURE.md` still describes `RepoDTO` with a frozen `path`, the empty ticket
provider, and omits `opencode` + `--remote-control`. Docs are a strength; drift erodes trust.
**Scope:** update `ARCHITECTURE.md` for dynamic repo resolution (FLO-40), Linear provider, the
`opencode` backend, remote-control attach. Cross-link the new `DAEMON-MIGRATION.md` /
`POSITIONING.md`.
**Acceptance:** doc matches `contract.ts` and current services; reviewer confirms no stale claims.
**Deps:** none. **Size:** S.

### P3 — Centralize agent-CLI constants
**Why:** `'claude'`, `--dangerously-skip-permissions`, `--session-id`, `--resume`,
`--remote-control`, poll interval, ports are inline literals scattered across services — a CLI
flag rename is grep-and-pray.
**Scope:** extract a single module (e.g. `electron/shared/agentCli.ts`) for binary names,
flags, and timing constants used by spawn/resume.
**Acceptance:** no agent-CLI literal appears outside the constants module (lint/grep check);
tests green.
**Deps:** none (but pairs naturally with P4). **Size:** S.

---

## Phase 1 — Backend abstraction (load-bearing refactor)

### P4 — Introduce `AgentBackend` adapter; collapse sessionManager triplication
**Why:** `agentKind === 'opencode'|'claude-code'` branches appear ~33× and
`start`/`resume`/`attachRemoteControl` each re-implement the same spawn/record/wire dance
(~120 dup lines). Every new backend is currently a shotgun edit. You're actively adding
backends — fix the seam first.
**Scope:**
- Define `AgentBackend { buildStartArgs, buildResumeArgs, buildRemoteControlArgs, statusSource }`.
- Implement `claudeCodeBackend` and `opencodeBackend`.
- Refactor `sessionManager` so the three entry methods share one `spawnAndRegister(mode)` path
  delegating to the selected backend.
**Acceptance:** sessionManager has no `agentKind` literal branching; adding a hypothetical 3rd
backend touches only one new file; all existing sessionManager/opencode tests green; +tests for
the adapter selection.
**Deps:** P3 (uses the constants). **Size:** M.

---

## Phase 2 — Daemon migration (the product)

### P5 — D0: Session survival across zero connected clients
**Why:** A pod's agents must keep running when *no* client is attached, not just across a single
reconnect.
**Scope:** audit every client-disconnect / WS-close path to prove none kills a PTY; document the
session lifecycle as client-independent.
**Acceptance:** new test — start a session, close all WS clients, reconnect later, full output
replays from `OutputBuffer` and the PTY is still live. No PTY is reaped on disconnect.
**Deps:** P4. **Size:** M.

### P6 — D1: Restart-restore with `interrupted` status
**Why:** Pod restarts/deploys currently drop running sessions silently. Metadata already
persists; drive restore from it.
**Scope:**
- Add `interrupted` to `SessionStatus` (coordinate the ~84 status-literal sites; consider a
  status constants map while here).
- On daemon boot: `ISessionStore.list()` → mark previously-`running` as `interrupted`.
- Wire a UI affordance to resume via the existing `sessionManager.resume()` path.
**Acceptance:** kill+restart the daemon → prior sessions show `interrupted` → resume reattaches
(claude `--resume`, opencode `--session`); tests for the boot-restore logic.
**Deps:** P5. **Size:** M.

### P7 — D2: Desktop-as-thin-client via local daemon child process
**Why:** **The keystone.** Today `main.ts` runs `createServices()` in-process, so desktop and
web are two backends. Invert it: one daemon, all UIs are thin clients.
**Scope:**
- Electron spawns/connects to a daemon (local child process by default) and talks to it over WS
  — same path the browser uses.
- Renderer no longer reaches services in-process; remove/retire the in-process IPC services path
  from the renderer's perspective.
- Configurable daemon URL so "connect to my pod" is the same code as "connect to localhost".
**Acceptance:** desktop app drives sessions over WS to a local daemon; closing the desktop UI
leaves agents running; pointing the URL at a remote daemon works identically; existing e2e
flows pass against the new path.
**Deps:** P6. **Size:** L. _(Consider splitting into P7a spawn/connect local daemon, P7b
remove in-process renderer path if review prefers.)_

### P8 — D3: Identity seam (`ownerId`) for future multi-user
**Why:** Cheap now, saves a rewrite later. Keeps the team-self-host (paid) tier additive.
**Scope:** auth resolves token → identity (`{id:'local'}`); add nullable `ownerId` to
`sessions`/`repos` (default `'local'`); RPC handlers filter by caller identity (no-op today).
**Acceptance:** schema migration applied; all reads scoped by identity; behavior identical for
the single owner; tests cover the filter.
**Deps:** P7. **Size:** S–M.

---

## Phase 3 — Pod productization (adoption lever)

### P9 — D4a: Clone-on-demand repo provisioning
**Why:** A pod needs to *get* repos onto itself. Rides on FLO-40 (resolve by remote URL).
**Scope:** register a repo by remote URL → daemon clones it into a managed location → worktrees
cut from there.
**Acceptance:** register by URL on a fresh pod → first agent runs against a freshly cloned repo;
errors are surfaced clearly (not the silent red bubble).
**Deps:** P7. **Size:** M.

### P10 — D4b: Git push identity & PR handoff on the pod
**Why:** Agents must push branches and open PRs from the pod; "agent done → here's the PR" is
make-or-break for value.
**Scope:** SSH key / scoped token provisioning on the pod; push from worktrees; surface the
resulting branch/PR URL in the UI.
**Acceptance:** an agent run completes → branch pushed → PR link shown; credentials never logged
(audit `runLogger`).
**Deps:** P9. **Size:** M–L.

### P11 — D4c: One-command pod deploy (Dockerfile + docs)
**Why:** Setup friction (pod, Tailscale, keys) is the #1 adoption barrier; lowering it *is* the
growth roadmap.
**Scope:** `Dockerfile` for the daemon; documented Tailscale + `SLIPSTREAM_TOKEN` + Anthropic
key setup; a single "deploy to a pod" path.
**Acceptance:** a new user follows the doc and reaches a working pod they drive from their phone;
healthz green.
**Deps:** P7 (P10 ideally). **Size:** M.

### P12 — Session GC / cost guard
**Why:** PTYs that outlive all clients forever = forgotten agents burning compute. "Small
laptop, big pod" only sells if idle pods don't bill endlessly.
**Scope:** idle/age cap or explicit-stop semantics surfaced in the UI; optional auto-stop on
`done`.
**Acceptance:** an idle/abandoned session is reaped per policy with a visible record; policy is
configurable.
**Deps:** P5. **Size:** S–M.

---

## Parallel / opportunistic (not blocking)

### PX1 — statusDetector hardening against real Claude TUI output
Roadmap #1. Coarse "needs you" heuristics → tuned against captured real output. **Deps:** none.
**Size:** M.

### PX2 — Multi-client write-conflict affordance
Two devices driving one PTY interleave keystrokes. Add a soft-lock / "second client is
view-only." Fine to defer until multi-device use is real. **Deps:** P7. **Size:** S–M.

---

## Critical path (one line)

**P1 → (P2,P3) → P4 → P5 → P6 → P7 → {P8, P9 → P10 → P11, P12}**

P7 (desktop-as-thin-client) is the moment Slipstream becomes the product. Everything before it
is zero-regret prep; everything after it is productizing the pod for someone other than you.
