import { BACKEND_KINDS, type BackendKind } from './contract.js'

export interface AgentMeta {
  kind: BackendKind
  /** Human-readable label, shown in the UI selector and handoff/error prompts. */
  label: string
  /** Short description shown beneath the UI selector. */
  description: string
  /** Path (under public/) to the agent's brand icon. */
  icon: string
  /**
   * Whether this kind has a chat transcript reader at all. Must exactly
   * mirror the per-kind branching in `readSessionChat`
   * (electron/services/sessionChatReader.ts): claude-code/pi/opencode/kilo/
   * grok are chat-capable there, antigravity always returns
   * `{available:false}` unconditionally.
   */
  supportsChat: boolean
  /**
   * Whether this kind has a usage reader at all. Must exactly mirror the
   * per-kind switch in `readSessionUsage`'s dispatch (electron/services/
   * usage.ts): claude-code/opencode/pi are usage-capable there; grok and
   * kilo fall through the `default` case to `emptyUsage` (no documented
   * on-disk format for grok; kilo's SQLite store isn't read yet); same for
   * antigravity.
   */
  supportsUsage: boolean
  /**
   * Whether this kind has a known `SKILL.md`-convention skills directory at
   * all. Must exactly mirror the per-kind dispatch in agentSkills.ts:
   * claude-code/opencode/pi are skills-capable there; antigravity/grok/kilo
   * have no known convention and always resolve to [].
   */
  supportsSkills: boolean
}

/**
 * Single source of truth for agent display metadata. Both the renderer's
 * agent selector (src/lib/agents.ts) and the backend's handoff/error prompts
 * (promptComposer.ts's AGENT_LABELS) derive from this table, so a mismatched
 * label can no longer surface as handoff text disagreeing with the UI. Keyed
 * by BackendKind (rather than an array) so adding a kind to the contract
 * without an entry here is a compile error, not a silent runtime fallback.
 */
const AGENT_META_BY_KIND: Record<BackendKind, Omit<AgentMeta, 'kind'>> = {
  'claude-code': {
    label: 'Claude Code',
    description: 'Uses claude --dangerously-skip-permissions in a git worktree.',
    icon: '/icons/agents/claude-code.svg',
    supportsChat: true,
    supportsUsage: true,
    supportsSkills: true,
  },
  opencode: {
    label: 'OpenCode',
    description:
      'Uses opencode in a git worktree with auto-discovered AGENTS.md and permissions set to allow.',
    icon: '/icons/agents/opencode.svg',
    supportsChat: true,
    supportsUsage: true,
    supportsSkills: true,
  },
  pi: {
    label: 'Pi',
    description: 'Uses pi --approve in a git worktree with an appended system prompt.',
    icon: '/icons/agents/pi.svg',
    supportsChat: true,
    supportsUsage: true,
    supportsSkills: true,
  },
  antigravity: {
    label: 'Antigravity',
    description:
      'Uses agy --dangerously-skip-permissions in a git worktree with auto-discovered AGENTS.md.',
    icon: '/icons/agents/antigravity.svg',
    supportsChat: false,
    supportsUsage: false,
    supportsSkills: false,
  },
  grok: {
    label: 'Grok',
    description: 'Uses grok in a git worktree with auto-discovered AGENTS.md.',
    icon: '/icons/agents/grok.svg',
    supportsChat: true,
    supportsUsage: false,
    supportsSkills: false,
  },
  kilo: {
    label: 'Kilo Code',
    description:
      'Uses kilo in a git worktree with auto-discovered AGENTS.md and permissions set to allow.',
    icon: '/icons/agents/kilo.svg',
    supportsChat: true,
    supportsUsage: false,
    supportsSkills: false,
  },
}

/** The agents surfaced in the UI selector, in BACKEND_KINDS order. Add new backends above. */
export const AGENT_META: readonly AgentMeta[] = BACKEND_KINDS.map((kind) => ({
  kind,
  ...AGENT_META_BY_KIND[kind],
}))

export const AGENT_LABELS: Record<BackendKind, string> = Object.fromEntries(
  BACKEND_KINDS.map((kind) => [kind, AGENT_META_BY_KIND[kind].label]),
) as Record<BackendKind, string>
