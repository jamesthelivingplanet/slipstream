import { describe, it, expect } from 'vitest'
import { buildSlipstreamSkillMd } from './cliSkillDoc.js'

describe('buildSlipstreamSkillMd', () => {
  const md = buildSlipstreamSkillMd()

  it('starts with YAML frontmatter (pi hard-requires it)', () => {
    expect(md.startsWith('---\n')).toBe(true)
    // A closing fence on its own line, after the frontmatter fields.
    expect(md.indexOf('\n---\n')).toBeGreaterThan(0)
  })

  it('has a pi-valid name: lowercase/hyphens, ≤64 chars', () => {
    const m = /^name: (.+)$/m.exec(md)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(m![1].length).toBeLessThanOrEqual(64)
    expect(m![1]).toBe('slipstream')
  })

  it('has a pi-valid description: non-empty, ≤1024 chars, single line', () => {
    const m = /^description: (.+)$/m.exec(md)
    expect(m).not.toBeNull()
    expect(m![1].length).toBeGreaterThan(0)
    expect(m![1].length).toBeLessThanOrEqual(1024)
  })

  it('documents every command', () => {
    for (const cmd of [
      'slipstream task-started',
      'slipstream request-input',
      'slipstream task-blocked',
      'slipstream approval-request',
      'slipstream checkpoint',
      'slipstream artifact publish',
      'slipstream task-complete',
      'slipstream open-mr',
      'slipstream help',
    ]) {
      expect(md).toContain(cmd)
    }
  })

  it('calls out the resume-to-task-started trap', () => {
    expect(md.toLowerCase()).toContain('resume')
    expect(md).toContain('task-started')
    // The specific trap: user replies while the agent was waiting.
    expect(md).toContain('the user just replied while I was waiting')
  })

  it('states the CLI is the only channel the app learns state through', () => {
    expect(md).toContain('ONLY through the `slipstream` CLI')
  })

  it('documents the exit codes', () => {
    expect(md).toContain('not inside a Slipstream session')
  })
})
