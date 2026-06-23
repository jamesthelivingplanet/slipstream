import { describe, it, expect } from 'vitest'
import {
  defaultUserPrompt,
  buildSystemPrompt,
  deliverPrompt,
} from './promptComposer.js'

describe('defaultUserPrompt', () => {
  it('returns "Begin implementing <tid>."', () => {
    expect(defaultUserPrompt('T-1')).toBe('Begin implementing T-1.')
  })
})

describe('buildSystemPrompt', () => {
  it('includes the tid in the output', () => {
    const result = buildSystemPrompt({ tid: 'T-42', title: 'Some feature', description: 'Details here' })
    expect(result).toContain('T-42')
  })

  it('includes the title in the output', () => {
    const result = buildSystemPrompt({ tid: 'T-42', title: 'Some feature', description: 'Details here' })
    expect(result).toContain('Some feature')
  })

  it('includes the description in the output', () => {
    const result = buildSystemPrompt({ tid: 'T-42', title: 'Some feature', description: 'Details here' })
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
    const result = deliverPrompt('codex' as never, { system: 'sys', user: 'usr' })
    expect(result.systemArgs).toEqual([])
    expect(result.userPrompt.startsWith('sys')).toBe(true)
  })
})
