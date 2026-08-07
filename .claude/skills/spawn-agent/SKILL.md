---
name: spawn-agent
description: Delegate genuinely separable work to an independent agent in its own worktree — find a target repo, spawn it, check on it, and wait for it. Use when a piece of work doesn't need your in-flight context and can run on its own branch.
---

# Spawning another agent

A spawned agent gets its own worktree, its own branch, and its own lifecycle
(see the `slipstream` skill for that side of things) — but it does **not**
share your context. It only knows what you put in its prompt.

## When to delegate

Delegate work that is genuinely separable: a task in another repo, or a
self-contained chunk of this one that doesn't depend on state only you hold
(files you have open mid-edit, a decision you haven't finished reasoning
through). If the work needs your in-flight context to succeed, do it
yourself instead — a spawned agent starts cold every time.

## Find a target repo

```sh
slipstream repos [--json]
```

Lists the repositories registered under **your owner** — spawning is scoped
to those, not every repo on the machine. Passing an unregistered repo to
`new-agent` is an error (`Unknown repo: <ref>`), not a silent no-op.

## Spawn

```sh
slipstream new-agent --repo <org/name> --title <t> [--prompt <p>] [--agent <kind>] [--json]
```

`--repo` and `--title` are required. `--prompt` is the spawned agent's
**entire starting context** — it has no memory of this conversation, so
write it as a complete, self-contained brief: what to do, why, and any
constraints, not a one-line pointer back to something only you know.
`--agent` picks a backend kind if you need something other than the
default. On success it prints the new `tid`, session id, and branch.

## The caps

Spawn depth and per-session fan-out are capped (`spawn.policy`, default
`maxDepth: 3`, `maxChildrenPerSession: 10`; `0` on either means unlimited).
Hitting a cap is a real, deterministic answer — not a transient failure —
so don't retry it:

```
Spawn depth limit reached (3): this agent is already 3 levels deep.
Spawn limit reached: this session already spawned 10 agents (max 10).
```

## Check on them

```sh
slipstream agents [--all] [--tid <tid>] [--json]
```

Plain `agents` lists your direct children. `--all` lists the whole subtree
(adds a DEPTH column). `--tid <tid>` shows one agent in full, including its
outcome and event history. `--all` and `--tid` cannot be combined.

## Wait for them

```sh
slipstream agents --wait [--timeout <seconds>] [--tid <tid>] [--all]
```

Polls every 5s until the watched agent(s) reach a terminal status (`done`,
`errored`, `interrupted`, `reaped`), or `--timeout` elapses (default 1800s /
30 minutes).

**`needs` is not terminal.** A child showing `needs` is blocked on a human,
not on work in progress — it will never resolve on its own, so waiting on it
just burns the timeout. Check status first (`slipstream agents`); if a
child is `needs`, resolve or escalate it instead of `--wait`-ing on it.

## Scripting it

`--json` on `repos`, `new-agent`, and `agents` prints the raw response
payload, not the table/prose the human view renders — it includes fields
the tables drop (e.g. `id` on repos; `branch`, `prUrl`, `outcome`, `events`
on agent detail). Parse that instead of scraping columns.

## Full command reference

Run `slipstream help` for the authoritative, always-current command and
exit-code reference. It isn't restated here: the command list and exit codes
are single-sourced in `electron/shared/slipstreamCommands.ts` and rendered
from there into every other doc surface, so a hand-typed copy here would
only drift.
