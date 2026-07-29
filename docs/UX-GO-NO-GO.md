# Core-UX go/no-go for a production cut (FLO-148)

The sixth [FLO-142](https://linear.app/floatilla/issue/FLO-142/production-readiness-blockers)
sub-issue was not a hardening gap — it was scope stability: core UX is still actively
finding its shape, so "production ready" can't be declared on UX grounds by feel. This doc
is the checklist that lets that call be made explicitly: an inventory of the in-flight
workstreams with a classification each (§1), a falsifiable bar for what "the interaction
model is stable enough to support" means (§2), where the UX freeze sits relative to
FLO-142's other blockers (§3), and a sign-off record to fill in at cut time (§4).

The mechanical gates — `pnpm readiness`, `pnpm check`/`pnpm test`/`pnpm lint`, `pnpm
release`, `/healthz`, migrations — live in
[docs/PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) §3 and are not repeated here. This
doc is only the half that needs a judgement call.

**The rule that makes this a decision rather than a default: silence on any row below is a
no-go, not a pass.** A workstream with no classification, or a platform with no stated
capability line, blocks the cut until someone writes one down.

## 1. In-flight core-UX workstreams

Classifications: **must-land** (the cut cannot be declared without it),
**behind-a-flag** (may ship incomplete because an existing capability flag or user
preference makes its absence an honest, non-broken state), **post-prod** (explicitly out of
the cut and deferred).

| Workstream | Where it lives | Classification |
|---|---|---|
| Chat-by-default | `src/lib/chatViewPrefs.ts` — `preferChatView` defaults `true`, persisted under `slipstream.chatViewMode` via `nativeStorage` | **Must-land — landed.** The reversible per-user preference *is* the flag; see B3. |
| Chat interface: claude-code, pi, opencode, grok | `electron/services/sessionChatReader.ts` + per-backend mappers; `supportsChat: true` in `electron/shared/agents.ts` | **Must-land — landed.** All four have a durable source, so history survives process exit and daemon restart. |
| Chat interface: kilo | Declares `supportsChat: true`; routed through the `usesEmbeddedServer` branch of `readSessionChat` | **Behind-a-flag, verify-or-demote.** That branch's durable fallback is `opencodeDbPath()`, hardcoded to `~/.local/share/opencode/opencode.db`. Kilo chat after the process exits is therefore unverified and likely reads as "nothing recovered". Either verify it end-to-end or flip `supportsChat` to `false` for kilo before the cut — do not ship the claim untested. |
| Chat interface: antigravity | `supportsChat: false`; `getChatMessages` returns `available:false` unconditionally; honest empty state steers to the terminal (0.6.0) | **Post-prod.** Terminal is the supported surface for this backend, stated not implied. |
| Night Ops: Android shell | FLO-150 (push action buttons), FLO-151 (inline reply), FLO-154 (input buffering across reconnects), FLO-155 (voice-to-text), FLO-160 (ongoing notification) | **Must-land — landed**, with the one exception on the next row. |
| Night Ops: Android reply-token at rest | `mobile/android/app/src/main/java/app/slipstream/mobile/ReplyPrefs.java` keeps the daemon bearer token in plaintext `MODE_PRIVATE` prefs; the source comment calls Keystore-backing a follow-up | **Must-land *if* the cut claims the Android shell.** Otherwise post-prod with the shell explicitly out of the cut. See B6 — this is the live instance of that gate. |
| Night Ops: iOS | Notification `actions` unsupported (degrades to a single-tap deep link); no inline reply; ongoing notification deliberately excluded — no iOS tokens | **Post-prod, explicitly out.** iOS gets the deep-link path only. No Night Ops parity is promised there, and this row is the statement required by B4. |
| Night Ops: installed PWA / desktop browser | Web Push with action buttons where the browser supports them; no inline reply, no ongoing notification (both are native-shell mechanisms) | **Ship as-is.** Stated, not implied — see B4. |
| Mission Control / responsive two-pane shell | `MissionControl.svelte`, `ResponsivePanel.svelte`, `MobileTermInput.svelte`; phone-width grid fixed in FLO-153 | **Must-land — landed.** One SPA serves desktop, PWA and the Capacitor WebView, so this surface has no per-platform fork to keep in parity. |
| Mobile app-store distribution | [docs/plans/TASK-I9S44-mobile-apps.md](plans/TASK-I9S44-mobile-apps.md) phases 3–5 (store compliance, signing, beta→production) | **Post-prod.** A separate cut with its own gates; the daemon's self-served APK over Tailscale is what this cut covers. |

**Three post-prod rows do not yet name a ticket** — antigravity chat, iOS Night Ops parity,
and the Android reply-token row if the cut ends up excluding the Android shell. Under B5
that makes them intentions rather than deferrals, so cutting those tickets is itself a
prerequisite to a go, not a nice-to-have. The kilo row is not a deferral at all: it is a
verify-or-demote before the cut.

## 2. The bar: what "stable enough to support" means

Six criteria. Each is checkable by someone other than its author — that is the point, and
the difference between this and "it feels done."

**B1 — No breaking interaction-surface change in the trailing window.** No breaking edit to
`electron/shared/contract.ts` or `electron/shared/wire.ts` across the last three tagged
releases. These are where a MAJOR bump originates (docs/VERSIONING.md), and a MAJOR means a
coordinated desktop+daemon upgrade — a forced migration event you do not want landing on
users immediately after declaring production readiness.

Check: `git log --oneline <tag-3>..HEAD -- electron/shared/contract.ts electron/shared/wire.ts`,
and confirm any commit it lists shipped as MINOR or PATCH.
Status at v0.9.0: **pass** — neither file has been touched since v0.6.0, across four
releases (0.7.0, 0.8.0, 0.8.1, 0.9.0).

**B2 — No dead ends.** For every entry in `BACKEND_KINDS`, the terminal view works, and the
chat view either has a real transcript or renders the empty state that says which of the
three cases applies (no chat view for this backend / nothing recoverable right now /
genuinely empty so far). No backend may land the user on a blank, silent default view.
The kilo row in §1 is the open instance.

Check: for each kind, start a session and open both views.

**B3 — The default view is reversible and sticky.** Chat-by-default must remain a
user-flippable preference that persists across reloads, with the terminal available at full
fidelity for every session. If the chat view ever becomes a route rather than a preference —
i.e. the user can no longer get back to the terminal for a session — that is a new no-go,
because it removes the escape hatch that makes shipping a still-moving chat surface safe.

Check: `src/lib/chatViewPrefs.ts` still exports a writable `preferChatView` with a
persisted setter, and the view toggle is reachable on both desktop and phone widths.

**B4 — Parity is stated per platform, never implied.** Each of desktop, installed PWA,
Android shell and iOS has an explicit capability line in §1. A platform with no line is a
no-go *for that platform* — not a silent pass, and not something to resolve by assuming the
shared SPA implies parity. It does not: the SPA is shared, but push, inline reply, ongoing
notifications, secure storage and haptics are all native-shell mechanisms that fork per
platform.

**B5 — Every workstream row is classified, and every post-prod row names a ticket.** An
unclassified row blocks the cut. A post-prod row without a ticket is an intention, not a
deferral.

**B6 — No open interaction-surface item rated MED or higher without a documented
mitigation.** This mirrors docs/PRODUCTION-READINESS.md §3's security gate, applied to the
UX surfaces. The live instance is the Android reply-token copy in `ReplyPrefs.java`: it sits
inside the documented at-rest threat model, but if the cut claims the Android shell, it
needs either Keystore-backing or a written, accepted-risk entry in docs/SECURITY.md — not a
source comment calling it a follow-up.

## 3. Freeze point relative to the other FLO-142 blockers

**The UX freeze is the last gate, not a peer of the hardening blockers.** FLO-143 (device
tokens), FLO-144 (WS tickets), FLO-145 (secrets at rest), FLO-146 (bwrap sandbox) and
FLO-147 (versioning) operate at the transport, storage and process layers and are orthogonal
to the interaction model. The dependency runs one way: a UX change can invalidate a
hardening assumption — a new chat transport reopens the WS-ticket surface and the CSP — but
hardening does not move the interaction model. So the ordering is: five hardening blockers
green, *then* freeze, *then* cut. As of v0.9.0 all five are shipped
(docs/PRODUCTION-READINESS.md §2), which makes this freeze the only thing between here and a
cut.

**What is frozen** is the interaction surface only, not `src/` at large:

- `src/lib/components/ChatView.svelte`, `ChatTurnList.svelte`, `TerminalView.svelte`,
  `MobileTermInput.svelte`, `MissionControl.svelte`, `ResponsivePanel.svelte`
- `src/lib/chatViewPrefs.ts`, `src/lib/chat.ts`
- `supportsChat` and the label/description table in `electron/shared/agents.ts`
- the `electron/shared/contract.ts` / `electron/shared/wire.ts` shapes those depend on

Everything else keeps moving normally.

**Duration**: the freeze opens the day the last §1 row is classified and holds until the
`vX.Y.Z` tag lands. During it, only PATCH-shaped fixes touch the frozen paths. A new
interaction model during the freeze goes behind a preference — the way chat-by-default did —
or waits for the far side of the tag.

**Exit**: the freeze lifts at the tag. After the cut, changes to the frozen paths follow
docs/VERSIONING.md as normal; an interaction-model change that forces a coordinated
desktop+daemon upgrade is a MAJOR bump, which is exactly the cost the freeze exists to make
visible rather than accidental.

**What the cut should be called — a decision for FLO-142/FLO-147 to ratify, not one this doc
lands unilaterally.** The recommendation is `pnpm release major` → **1.0.0**.
docs/VERSIONING.md defines MAJOR as the breaking-change signal but is silent on 0.x. While
the repo stays on 0.x, that MAJOR rule never fires in practice, so "production ready" would
carry no mechanical compatibility promise — the support commitment would exist only in prose.
Cutting 1.0.0 is what makes the versioning scheme's own promise binding.

## 4. Sign-off

Fill this in at cut time. An unfilled row is a no-go. A waiver is allowed, but it must be
written down here with its reason — a waived gate is a decision, an empty one is an
oversight.

| Gate | Verdict (go / no-go / waived) | Decided by | Date | Note |
|---|---|---|---|---|
| §1 every row classified | | | | |
| B1 no breaking contract/wire change in trailing 3 releases | | | | |
| B2 no dead-end views (incl. the kilo verify-or-demote) | | | | |
| B3 chat-by-default reversible and sticky | | | | |
| B4 per-platform capability lines stated | | | | |
| B5 post-prod rows all have tickets | | | | |
| B6 no un-mitigated MED+ UX item (incl. Android reply-token) | | | | |
| §3 freeze opened, and scope agreed | | | | |
| §3 cut version agreed (1.0.0 recommended) | | | | |

Record the same decision against the named posture rung from
docs/PRODUCTION-READINESS.md §1 — a UX go for rung 2 (single-owner over Tailscale) is not a
go for rung 4 (multi-device), where the reply-token and per-platform rows carry more weight.

See also: [docs/PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) (posture ladder, blocker
status, mechanical gates), [docs/VERSIONING.md](VERSIONING.md) (what MAJOR/MINOR commit to),
[docs/SECURITY.md](SECURITY.md) (where a B6 accepted-risk entry goes).
