# Daemon Migration — Design Doc

_Status: proposal. Author: design pass, 2026-06-28._

The single enabling feature behind the product thesis ("run agents on infra you own,
manage them from any device") is turning the **server into the source of truth** — a
long-lived daemon that owns every agent, with all UIs (desktop, phone browser, laptop
browser) as thin, stateless clients that *attach* to sessions they did not spawn.

This doc maps that change onto the code as it exists today and phases it so each step ships
independently.

---

## 1. Where we are

```
┌─ Desktop (Electron) ────────────┐      ┌─ Browser (phone/laptop) ─┐
│ Renderer (Svelte)               │      │ Renderer (Svelte)        │
│   │ window.slipstream (IPC)     │      │   │ window.slipstream (WS)│
│ main.ts → createServices() ◀────┼──┐   │ wsApi ──────────────────┼──┐
│   sessionManager owns PTYs      │  │   └──────────────────────────┘  │
└─────────────────────────────────┘  │                                 │
                                      ▼                                 ▼
                          TWO SEPARATE BACKENDS, each with its own PTYs and DB.
                          A desktop session is invisible to the web server and vice-versa.
```

- `main.ts:42` — `createServices(app.getPath('userData'))` runs **in the Electron main
  process**. The desktop app spawns and owns PTYs locally.
- `server.ts` — `pnpm serve` calls `createServices(...)` **again**, in its own process, with
  its own SQLite file and its own PTYs.
- `ARCHITECTURE.md` states this plainly: *"PTY sessions live in whichever process spawned
  them … the standalone server does not share live sessions with a separately-running
  desktop app."*

**Consequence:** there is no single place agents live. The pod vision has no home.

### What already exists in our favor

| Asset | Where | Why it matters |
|---|---|---|
| Transport-free RPC core | `electron/core/rpc.ts` (`createRpc`) | Already proven to back **both** IPC and WS. The daemon just makes it the *only* host. |
| Output replay buffer | `electron/services/outputBuffer.ts` (256 KB + monotonic `seq`) | The exact primitive for "attach to a running session, lose no bytes." Already handles WS reconnect. |
| Session metadata persistence | `ISessionStore` → `sessionStore.ts` → SQLite `sessions` table | Restart-restore is **half-built**: metadata survives, only the live PTY dies. |
| Wire protocol | `electron/shared/wire.ts` (`req`/`res`/`push`) | Client↔daemon transport already specified and tested. |
| Token auth on upgrade | `server.ts` | Single-owner auth is already done. |

We are closer than the roadmap's "Later" label implies. The hard primitives are built; what's
missing is **inverting ownership** and **surviving the absence of clients**.

---

## 2. Target state

```
┌─ Desktop (Electron) ─┐   ┌─ Phone browser ─┐   ┌─ Laptop browser ─┐
│ Renderer (thin)      │   │ Renderer (thin) │   │ Renderer (thin)  │
└──────────┬───────────┘   └────────┬────────┘   └────────┬─────────┘
           │ wsApi (WS /rpc)        │ wsApi               │ wsApi
           └────────────────────────┴─────────────────────┘
                                    │
                      ┌─────────────▼──────────────┐
                      │   slipstream daemon (pod)   │
                      │   createServices(...)       │
                      │   sessionManager owns PTYs  │  ← the ONLY backend
                      │   SQLite (single source)    │
                      └─────────────────────────────┘
```

- **One backend.** PTYs live in the daemon. They outlive every client connection — including
  *all clients being absent*.
- **Desktop becomes a thin client.** Electron stops calling `createServices` in-process and
  instead points `wsApi` at a daemon URL (which may be `localhost` for "run it on this
  machine" or a pod URL for "run it on my server"). The renderer doesn't know or care.
- **Multi-client attach.** Two devices can watch and drive the same live session
  concurrently, each replaying from the `OutputBuffer` on attach and then following live.

The key realization: **`pnpm serve` already IS the daemon.** This migration is mostly about
(a) making the desktop app a *consumer* of it instead of a peer, and (b) making sessions
survive having zero connected clients.

---

## 3. The four changes

### C1 — Session survival (PTYs outlive all clients)
Today a PTY is fine across a single WS reconnect (buffer replays). It must also be fine when
**no client is connected at all** — the daemon keeps the `node-pty` process and its
`OutputBuffer` alive in `sessions: Map<…>`. This is mostly already true (the map is
process-lived, not connection-lived); the work is auditing the lifecycle so no client
disconnect path kills a PTY, and adding a daemon-level idle/GC policy (see Open Questions).

### C2 — Restart-restore (PTYs survive daemon restart)
PTYs cannot literally survive a process restart, but the **session list** can, and we can
offer reattach/replay. On daemon boot:
1. Load `ISessionStore.list()` (already persisted).
2. Mark previously-`running` sessions as `interrupted` (a new terminal status) rather than
   silently dropping them.
3. Offer **resume** via the existing `sessionManager.resume()` path — for `claude-code` this
   already replays the transcript (`--resume <id>`), for `opencode` via `--session <sid>`.

Most of this machinery (`resume`, `hasTranscript`, `opencodeSid` persistence) **already
exists** — it needs to be driven automatically on boot instead of manually.

### C3 — Desktop-as-thin-client
`main.ts` stops calling `createServices` directly. Instead:
- The Electron app either **spawns a local daemon child process** (so "just works" offline)
  or **connects to a configured remote daemon URL**.
- The renderer always talks `wsApi` — there is no longer an in-process IPC path to the
  services. (The IPC adapter can remain for the bundled-local-daemon case, but the cleaner
  end state is one transport: WS to `localhost` or to the pod.)
- This deletes the "two backends" divergence at the root.

### C4 — Identity seam (zero-cost future-proofing for multi-user)
Even while single-owner, thread an `ownerId` through session ownership and the auth layer:
- Auth resolves a token → an **identity** (`{ id: "local" }` today). The daemon never assumes
  "one user"; it asks "who is this request" and gets `"local"`.
- `sessions` and `repos` gain a nullable `ownerId` column (defaults `"local"`).
- RPC handlers filter by the caller's identity (a no-op filter today).

This costs almost nothing now and turns the single-owner → team-self-host jump from a rewrite
into an additive change (swap the token validator for a user table; the filters light up).
See the tenancy analysis in the strategy discussion — **build for single-owner, architect for
team.**

---

## 4. Phasing

Each phase is independently shippable and leaves the app working.

| Phase | Deliverable | Risk | Unlocks |
|---|---|---|---|
| **D0** | Audit & guarantee C1: no client-disconnect path kills a PTY; add tests that a session survives WS close+reopen with zero clients in between | Low | Sessions already feel "always on" over the network |
| **D1** | C2 restart-restore: boot-time `list()` → mark `interrupted` → drive `resume` on demand; new `interrupted` status + UI affordance | Med | Survive deploys/restarts of the pod |
| **D2** | C3 desktop-as-thin-client: Electron connects to a daemon (local child or remote URL) over WS; remove the in-process `createServices` path from the renderer's perspective | Med-High | **The product:** one backend, desktop and phone are peers onto the pod |
| **D3** | C4 identity seam: `ownerId` plumbed, auth → identity, no-op filters | Low | Team self-host becomes additive, not a rewrite |
| **D4** | Pod operational story: repo clone-on-demand from remote URL, git push credentials, Anthropic key provisioning, `Dockerfile` + deploy doc | Med | Someone other than the author can actually run a pod |

D0–D1 are hardening you'd want regardless. **D2 is the keystone** — it's where "it runs on a
server" becomes "it's the same product everywhere." D4 is what turns it from "works on my
pod" into "works on yours."

---

## 5. The hard problems D4 must answer (the real product work)

These are out of scope for the core migration but are what make a *pod* valuable vs a
*localhost server*:

- **Git identity on the pod.** Agents clone private repos and push branches/PRs back. Needs
  an SSH key or scoped token on the pod and a clean "agent done → here's the PR" flow.
  FLO-40 (resolve repos by remote URL) is the enabling step — clone-on-demand from that URL.
- **Secrets on the server.** Anthropic/Claude auth now lives on the pod. Provisioning +
  rotation; never logged (audit `runLogger` for prompt/secret leakage).
- **Security surface.** Agents already run `--dangerously-skip-permissions`; the pod now also
  holds push credentials. Behind Tailscale + bearer token this is fine for one owner. **Do
  not** expose publicly without revisiting the threat model — this is also the line where the
  managed-SaaS option would force a complete isolation rewrite.
- **Pod lifecycle / cost.** Always-on compute costs money. A scale-to-zero / sleep-wake story
  becomes a real feature ("small laptop, big pod" only sells if the pod isn't billing while
  idle).

---

## 6. Open questions

1. **Local daemon: child process or in-process?** D2 can either spawn a real local daemon the
   Electron app talks to over WS (uniform, one code path, survives the UI closing) or keep an
   in-process services instance for offline. The former is more honest to the architecture and
   gives "agents keep running with the UI closed" for free on the desktop too. Recommend the
   child-process daemon.
2. **Session GC policy.** If PTYs outlive all clients forever, a forgotten agent runs (and
   bills) indefinitely. Need an idle/age cap or explicit "stop" semantics surfaced in the UI.
3. **Multi-client write conflicts.** Two devices driving one PTY = interleaved keystrokes.
   Acceptable for a single owner (it's you on two devices); needs a soft-lock / "view-only on
   the second client" affordance before multi-user.
4. **`interrupted` status semantics.** New `SessionStatus` member vs reusing `errored`. New
   member is cleaner but touches the 84 status-literal sites — do it alongside the
   status-centralization cleanup from the code-health pass.

---

## 7. Why this is zero-regret

Every tenancy future (single-owner, team self-host, managed SaaS) begins with the same task:
**make the server the one backend.** D0–D2 are required for all three and undermine none of
them. D3 keeps the highest-value path (team self-host, moat intact) cheap. Nothing here
commits us to the moat-dissolving managed-SaaS path; it simply stops blocking the good ones.
