# Positioning

> This is a placeholder stub — to be fleshed out.

Slipstream is a **control surface for orchestrating many autonomous coding agents** across isolated git worktrees. It lets you launch, monitor, and interact with multiple parallel agent runs (claude-code or opencode) — each in its own worktree — from a single UI.

Key characteristics:

- **Real-data-only**: ticket sources are behind `ITicketProvider`; currently Linear (personal API key, no mocks).
- **Isolated worktrees**: each agent session gets its own git worktree so branches don't interfere.
- **Reachable anywhere**: the same Svelte UI runs in Electron on the desktop *or* in a browser/phone over a Tailscale tailnet (headless web mode with a WebSocket backend).
- **Agent-agnostic**: pluggable backends — currently `claude-code` and `opencode`.

See [Architecture](ARCHITECTURE.md) for the technical design and [Roadmap](ROADMAP.md) for what's done and what's next.
