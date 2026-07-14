import { describe, it, expect } from 'vitest'
import {
  defaultUserPrompt,
  buildSystemPrompt,
  buildAgentsMdContent,
  deliverPrompt,
  buildHandoffPrompt,
  AGENT_LABELS,
} from './promptComposer.js'

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
    for (const cmd of [
      'slipstream task-started',
      'slipstream request-input',
      'slipstream task-blocked',
      'slipstream approval-request',
      'slipstream task-complete',
    ]) {
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

describe('AGENT_LABELS', () => {
  it('includes a label for every backend kind', () => {
    expect(AGENT_LABELS['claude-code']).toBe('Claude Code')
    expect(AGENT_LABELS.opencode).toBe('OpenCode')
    expect(AGENT_LABELS.pi).toBe('Pi')
    expect(AGENT_LABELS.antigravity).toBe('Antigravity')
    expect(AGENT_LABELS.grok).toBe('Grok')
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
})
