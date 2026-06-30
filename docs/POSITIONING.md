# Positioning & Product Brief

_Status: draft. 2026-06-28._

## TL;DR

The mobile/remote angle is necessary but **not** differentiating — Omnara and Cursor already
ship phone control of agents. The defensible wedge is one level deeper:

> **Slipstream is the self-hosted command center for coding agents. Your compute, your keys,
> your code — agents run on infrastructure *you* own (a pod, a home server, a beefy desktop),
> and you drive them from any device. No vendor ever sees your repos, your prompts, or your
> Anthropic key.**

"Small laptop, big pod" is the image. **Sovereignty** is the moat.

---

## The competitive map (June 2026)

There are two distinct clusters, and Slipstream is trying to occupy the gap between them.

### Cluster A — Local parallel-agent orchestrators
_Conductor (Mac app), Crystal→Nimbalyst, Claude Squad, Vibe Kanban (Bloop shut down early
2026; now community OSS), Emdash, Baton, Superset, Agent Kanban._

- **Shape:** desktop apps that run N agents in parallel, each in its own git worktree, with a
  diff/PR review surface. Local-first, your machine.
- **Strength:** good worktree isolation + review UX; private by construction (nothing leaves
  your box).
- **Weakness:** **tied to one machine.** Close the laptop and the agents die. No remote, no
  mobile, no "check it from the train." This is the exact limitation Slipstream's daemon
  removes.

### Cluster B — Remote/cloud agent command centers
_Omnara, Cursor remote/background agents, Devin._

- **Shape:** run/monitor/steer agents from phone, web, watch. Omnara: agent runs on your
  machine but **sessions migrate to *their* cloud** when your laptop goes offline; native
  iOS/Android/Watch; free. Cursor: agents run on Cursor's infra. Devin: fully hosted.
- **Strength:** true "from anywhere" access; polished mobile; voice.
- **Weakness:** **a third party sits in the middle.** Your code, prompts, and traffic route
  through a vendor's cloud (Omnara's relay, Cursor's/Devin's compute). For anyone with IP
  sensitivity, compliance constraints, or just principle, that's a non-starter — and you
  can't bring your own compute or keys end-to-end.

### The gap Slipstream fills

> **Cluster A's privacy + locality, with Cluster B's from-anywhere access — and neither
> vendor's cloud in the middle.**

Nobody is cleanly occupying "remote/mobile access to parallel agents that run **entirely on
infrastructure you control**, with **no vendor relay**." That's the position.

| | Local orchestrators (Conductor, Crystal…) | Cloud command centers (Omnara, Cursor, Devin) | **Slipstream** |
|---|---|---|---|
| Parallel agents in worktrees | ✅ | partial | ✅ |
| Access from phone / anywhere | ❌ | ✅ | ✅ |
| Agents survive laptop closing | ❌ | ✅ (via vendor cloud) | ✅ (via **your** daemon) |
| Code never leaves infra you own | ✅ | ❌ | ✅ |
| Bring your own compute | ✅ (only your laptop) | ❌ | ✅ (**any** pod/server) |
| Bring your own keys, no middleman | ✅ | ❌ | ✅ |
| Self-hostable | ✅ (local only) | ❌ | ✅ (**remote-capable**) |

The honest read: each competitor wins one column decisively. Slipstream's bet is that a real
segment wants the **whole row** — and that's a row no incumbent can copy without abandoning
their model (the local apps would have to build a secure remote daemon; the cloud vendors
would have to give up the relay that *is* their business).

---

## Who this is for (ICP)

Ranked by how acute the pain is and how much they'll value sovereignty.

1. **Privacy/IP-sensitive senior engineers & small teams.** Work on proprietary or regulated
   code; cannot or will not route it through Omnara/Cursor/Devin clouds. Already comfortable
   with Tailscale, a VPS, their own keys. **This is the beachhead** — the wedge matters most
   to them and they self-serve.
2. **"Homelab / sovereign stack" developers.** Run their own everything on principle. The
   "put it on my pod, drive from my phone" story is intrinsically appealing; they'll be the
   loudest advocates and earliest OSS contributors.
3. **Power users running many agents.** Want a beefy always-on box doing the work while they
   carry a thin client. The "small laptop, big pod" topology is the draw; cost-efficiency of
   one shared pod vs. N hosted seats is a bonus.
4. **(Later) Teams wanting a shared self-hosted agent server.** The paid tier — one pod, the
   whole team's agents, code stays in-house. This is the GitLab/Sentry self-host playbook and
   the commercial target the daemon's `ownerId` seam keeps cheap to reach.

Explicitly **not** the ICP early: non-technical buyers who want zero-setup hosted convenience
— that's Omnara/Cursor's game, and chasing it dissolves the moat.

---

## Narrative & messaging

- **One-liner:** _"Run your coding agents on your own pod. Steer them from anywhere. Nobody
  else in the loop."_
- **The hero image:** a cheap laptop / a phone on the train, driving a rack of agents on a
  pod you own. The agents don't sleep when you close the lid — because they were never on
  your lid.
- **The contrast line (vs. Omnara/Cursor):** _"They keep your agents running by moving your
  code to their cloud. We keep them running on yours."_
- **The contrast line (vs. Conductor/local):** _"All the parallel-worktree power of a local
  orchestrator — except it doesn't die when you close your laptop."_
- **Proof points to build toward:** end-to-end "your key never touches our servers (there are
  no our servers)", Tailscale-native, one-command pod deploy, agents reattach after the pod
  restarts.

---

## Go-to-market shape (open-core)

Maps 1:1 onto the tenancy ladder in `DAEMON-MIGRATION.md`:

| Tier | Who | Price | Purpose |
|---|---|---|---|
| **Self-host, single-owner** | ICP 1–3 | Free / OSS | Trust, adoption, community, credibility the cloud vendors can't buy |
| **Self-host, team** | ICP 4 | Paid (license / support / per-seat) | The revenue line; moat fully intact |
| **Managed** | — | — | **Deliberate non-goal.** Adopting it = becoming a worse-funded Omnara/Devin and discarding the moat. Revisit only if a customer funds it. |

Open-core is the right structure because the wedge *is* self-hosting — you can't out-market
Omnara on convenience, but you can own the audience that will never accept a middleman, and
that audience pays for the team tier.

---

## Risks & honest counterarguments

- **"Omnara is free and polished."** True. We will not win on convenience or mobile polish
  early. We win only with the sovereignty crowd — so messaging must lead with that, not with
  "we also have a phone app."
- **"The market that cares about self-hosting is small."** Possibly — but it's underserved,
  high-intent, technical (self-serves), and the natural source of advocates and contributors.
  Beachhead, not TAM.
- **"Cloud vendors could add self-host."** They'd be cannibalizing the relay/compute that is
  their business model. Structural reluctance is our protection — same reason Conductor is
  unlikely to build a secure remote daemon (it dilutes their local-simplicity pitch).
- **"Setup friction (pod, Tailscale, keys) limits adoption."** Real. D4 (one-command pod
  deploy, clone-on-demand) is therefore not polish — it's the adoption lever. Lowering setup
  cost *is* the growth roadmap.

---

## What would prove the thesis

1. A handful of ICP-1 users running a real pod daily and saying _"I'd be upset if this went
   away"_ (the only signal that matters pre-revenue).
2. Unprompted "finally, one that doesn't phone home" sentiment.
3. At least one team asking to pay for multi-user self-host — validating the revenue tier
   before building it.

Sources: [Omnara](https://www.omnara.com/),
[Cursor remote agents](https://www.buildfastwithai.com/blogs/cursor-remote-agents-any-device-2026),
[Conductor & the 2026 ecosystem](https://rustman.org/wiki/conductor-parallel-agents/),
[Best multi-agent coding tools 2026 (Nimbalyst)](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/),
[Open-source agent orchestrators](https://www.augmentcode.com/tools/open-source-agent-orchestrators).
