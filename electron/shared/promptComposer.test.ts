import { describe, it, expect } from 'vitest'
import {
  defaultUserPrompt,
  buildSystemPrompt,
  buildAgentsMdContent,
  deliverPrompt,
  buildHandoffPrompt,
  formatChatExcerpt,
  AGENT_LABELS,
} from './promptComposer.js'
import { LIFECYCLE_INVOCATIONS } from './slipstreamCommands.js'
import type { SessionChatMessageDTO } from './contract.js'

describe('defaultUserPrompt', () => {
  it('returns "Begin implementing <tid>."', () => {
    expect(defaultUserPrompt('T-1')).toBe('Begin implementing T-1.')
  })
})

describe('buildSystemPrompt', () => {
  it('includes the tid in the output', () => {
    const result = buildSystemPrompt({
      tid: 'T-42',
      title: 'Some feature',
      description: 'Details here',
    })
    expect(result).toContain('T-42')
  })

  it('includes the title in the output', () => {
    const result = buildSystemPrompt({
      tid: 'T-42',
      title: 'Some feature',
      description: 'Details here',
    })
    expect(result).toContain('Some feature')
  })

  it('includes the description in the output', () => {
    const result = buildSystemPrompt({
      tid: 'T-42',
      title: 'Some feature',
      description: 'Details here',
    })
    expect(result).toContain('Details here')
  })

  it('uses "No description provided." when description is missing', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('No description provided.')
  })

  it('uses "No description provided." when description is empty string', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug', description: '' })
    expect(result).toContain('No description provided.')
  })

  it('uses "No description provided." when description is whitespace only', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug', description: '   ' })
    expect(result).toContain('No description provided.')
  })

  it('includes process framing word "worktree"', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('worktree')
  })

  it('includes process framing word "PR" or "pull request"', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    const lower = result.toLowerCase()
    expect(lower.includes('pr') || lower.includes('pull request')).toBe(true)
  })

  it('includes process framing word "tests"', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('tests')
  })

  it('makes the resume-from-waiting transition to task-started explicit', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result.toLowerCase()).toContain('resume')
    expect(result).toContain('slipstream task-started')
  })

  it('names the CLI as the only status channel and points at the skill', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('ONLY through the `slipstream` CLI')
    expect(result).toContain('slipstream help')
  })

  it('covers the full lifecycle command set', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    // Derived from the shared spec so the lifecycle subset can't drift from it.
    for (const cmd of LIFECYCLE_INVOCATIONS) {
      expect(result).toContain(cmd)
    }
  })

  it('routes the merge request through slipstream open-mr', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('slipstream open-mr')
  })

  it('instructs reporting "running" before investigating or replying', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('before doing anything else')
  })

  it('instructs "done" is the final action', () => {
    const result = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    expect(result).toContain('as your final action')
  })
})

describe('deliverPrompt', () => {
  it('returns --append-system-prompt args when system is present', () => {
    const result = deliverPrompt('claude-code', { system: 'sys content', user: 'usr content' })
    expect(result.systemArgs).toEqual(['--append-system-prompt', 'sys content'])
    expect(result.userPrompt).toBe('usr content')
  })

  it('returns empty systemArgs when system is empty', () => {
    const result = deliverPrompt('claude-code', { system: '', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })

  it('default fallback branch prepends system to user with empty systemArgs', () => {
    const result = deliverPrompt('unknown-backend' as never, { system: 'sys', user: 'usr' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt.startsWith('sys')).toBe(true)
  })
})

describe('buildAgentsMdContent', () => {
  it('returns the system prompt as-is', () => {
    const result = buildAgentsMdContent('You are an autonomous agent.')
    expect(result).toBe('You are an autonomous agent.')
  })

  it('handles multi-line system prompts', () => {
    const prompt = 'Line 1\nLine 2\nLine 3'
    const result = buildAgentsMdContent(prompt)
    expect(result).toBe(prompt)
  })
})

describe('deliverPrompt with opencode', () => {
  it('returns empty systemArgs when system is present (system goes via AGENTS.md)', () => {
    const result = deliverPrompt('opencode', { system: 'sys content', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })

  it('returns empty systemArgs when system is empty', () => {
    const result = deliverPrompt('opencode', { system: '', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })
})

describe('deliverPrompt with pi', () => {
  it('returns --append-system-prompt args when system is present', () => {
    const result = deliverPrompt('pi', { system: 'sys content', user: 'usr content' })
    expect(result.systemArgs).toEqual(['--append-system-prompt', 'sys content'])
    expect(result.userPrompt).toBe('usr content')
  })

  it('returns empty systemArgs when system is empty', () => {
    const result = deliverPrompt('pi', { system: '', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })
})

describe('deliverPrompt with antigravity', () => {
  it('returns empty systemArgs when system is present (system goes via AGENTS.md)', () => {
    const result = deliverPrompt('antigravity', { system: 'sys content', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })

  it('returns empty systemArgs when system is empty', () => {
    const result = deliverPrompt('antigravity', { system: '', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })
})

describe('deliverPrompt with grok', () => {
  it('returns empty systemArgs when system is present (system goes via AGENTS.md)', () => {
    const result = deliverPrompt('grok', { system: 'sys content', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })

  it('returns empty systemArgs when system is empty', () => {
    const result = deliverPrompt('grok', { system: '', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })
})

describe('deliverPrompt with kilo', () => {
  it('returns empty systemArgs when system is present (system goes via AGENTS.md)', () => {
    const result = deliverPrompt('kilo', { system: 'sys content', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })

  it('returns empty systemArgs when system is empty', () => {
    const result = deliverPrompt('kilo', { system: '', user: 'usr content' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt).toBe('usr content')
  })
})

describe('AGENT_LABELS', () => {
  it('includes a label for every backend kind', () => {
    expect(AGENT_LABELS['claude-code']).toBe('Claude Code')
    expect(AGENT_LABELS.opencode).toBe('OpenCode')
    expect(AGENT_LABELS.pi).toBe('Pi')
    expect(AGENT_LABELS.antigravity).toBe('Antigravity')
    expect(AGENT_LABELS.grok).toBe('Grok')
    expect(AGENT_LABELS.kilo).toBe('Kilo Code')
  })
})

describe('buildHandoffPrompt', () => {
  const baseCtx = {
    tid: 'T-42',
    title: 'Some feature',
    prompt: 'Please implement the widget exactly as specced.',
    fromAgent: 'Claude Code',
    branch: 'jane-t-42-some-feature',
    base: 'main',
  }

  it('signals this is a takeover, not a fresh start', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('taking over an in-progress run')
    expect(result).toContain('Do not start over')
  })

  it('includes the fromAgent label', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('Claude Code')
  })

  it('includes the tid and title', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('T-42: Some feature')
  })

  it('includes the original prompt verbatim', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('Please implement the widget exactly as specced.')
  })

  it('tells the agent to inspect git history against base', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('git log main..HEAD')
  })

  it('includes the branch name', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('jane-t-42-some-feature')
  })

  it('includes the outcome summary when provided', () => {
    const result = buildHandoffPrompt({
      ...baseCtx,
      outcomeSummary: 'Implemented the API, blocked on flaky CI.',
    })
    expect(result).toContain('Implemented the API, blocked on flaky CI.')
  })

  it('omits "last reported summary" when outcomeSummary is not provided', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).not.toContain('last reported summary')
  })

  it('includes the prior conversation under a "Conversation so far" section when provided', () => {
    const result = buildHandoffPrompt({
      ...baseCtx,
      priorConversation: 'User: fix the bug\n\nAssistant: Investigating now.',
    })
    expect(result).toContain('Conversation so far (from Claude Code)')
    expect(result).toContain('User: fix the bug')
    expect(result).toContain('Assistant: Investigating now.')
  })

  it('points the agent at the conversation excerpt instead of warning about missing scrollback', () => {
    const result = buildHandoffPrompt({
      ...baseCtx,
      priorConversation: 'User: fix the bug',
    })
    expect(result).toContain('conversation excerpt above')
    expect(result).not.toContain('terminal scrollback from before is not available')
  })

  it('falls back to the scrollback/git-state wording when no prior conversation is available', () => {
    const result = buildHandoffPrompt(baseCtx)
    expect(result).toContain('terminal scrollback from before is not available')
    expect(result).not.toContain('Conversation so far')
  })
})

function msg(
  role: 'user' | 'assistant',
  text: string,
  overrides: Partial<SessionChatMessageDTO> = {},
): SessionChatMessageDTO {
  return {
    uuid: `${role}-${text.slice(0, 4)}`,
    role,
    blocks: [{ type: 'text', text }],
    ts: 0,
    ...overrides,
  }
}

describe('formatChatExcerpt', () => {
  it('returns an empty string for no messages', () => {
    expect(formatChatExcerpt([])).toBe('')
  })

  it('renders a user/assistant exchange with role labels', () => {
    const out = formatChatExcerpt([
      msg('user', 'Begin implementing T-1.'),
      msg('assistant', 'Investigating the codebase.'),
    ])
    expect(out).toContain('User: Begin implementing T-1.')
    expect(out).toContain('Assistant: Investigating the codebase.')
  })

  it('renders tool_use blocks as a compact [tool name: input] marker', () => {
    const out = formatChatExcerpt([
      {
        uuid: 'a1',
        role: 'assistant',
        ts: 0,
        blocks: [
          { type: 'text', text: 'Running a command.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    ])
    expect(out).toContain('Assistant: Running a command.')
    expect(out).toContain('[tool Bash: {"command":"ls -la"}]')
  })

  it('renders tool_result blocks, marking errors distinctly', () => {
    const ok = formatChatExcerpt([
      {
        uuid: 'u1',
        role: 'user',
        ts: 0,
        blocks: [{ type: 'tool_result', toolUseId: 't1', content: 'src/ tests/' }],
      },
    ])
    expect(ok).toContain('[tool result: src/ tests/]')

    const err = formatChatExcerpt([
      {
        uuid: 'u2',
        role: 'user',
        ts: 0,
        blocks: [{ type: 'tool_result', toolUseId: 't1', content: 'boom', isError: true }],
      },
    ])
    expect(err).toContain('[tool error: boom]')
  })

  it('truncates long text blocks to perBlockChars with an ellipsis', () => {
    const long = 'x'.repeat(100)
    const out = formatChatExcerpt([msg('user', long)], { perBlockChars: 20 })
    expect(out).toHaveLength('User: '.length + 20)
    expect(out.endsWith('\u2026')).toBe(true)
  })

  it('keeps the most recent messages and drops oldest when maxMessages binds', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => msg('user', `m${i}`))
    const out = formatChatExcerpt(msgs, { maxMessages: 2, maxChars: 1000 })
    expect(out).toContain('m3')
    expect(out).toContain('m4')
    expect(out).not.toContain('m2')
  })

  it('keeps the most recent messages and drops oldest when the char budget binds', () => {
    const msgs = [
      msg('user', 'oldest message that should be dropped'),
      msg('assistant', 'recent message one'),
      msg('assistant', 'recent message two'),
    ]
    // Budget only fits the two most recent whole messages.
    const out = formatChatExcerpt(msgs, { maxChars: 60, maxMessages: 10 })
    expect(out).toContain('recent message one')
    expect(out).toContain('recent message two')
    expect(out).not.toContain('oldest message')
  })

  it('skips messages whose blocks render to nothing (e.g. text is blank)', () => {
    const out = formatChatExcerpt([
      { uuid: 'x', role: 'assistant', ts: 0, blocks: [{ type: 'text', text: '   ' }] },
      msg('user', 'real content'),
    ])
    expect(out).toBe('User: real content')
  })
})
