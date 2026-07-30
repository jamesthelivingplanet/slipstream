import { describe, it, expect } from 'vitest'
import { AGENT_META, AGENT_LABELS } from './agents.js'
import { BACKEND_KINDS } from './contract.js'
import type { BackendKind } from './contract.js'

/** Ground truth for the capability matrix, verified against each mirrored
 *  module (sessionChatReader.ts for chat, usage.ts's readSessionUsage
 *  dispatch for usage, agentSkills.ts for skills). Kept here as an
 *  independent table so a future edit to agents.ts that silently drifts
 *  from the real per-backend behavior fails this test rather than shipping. */
const EXPECTED: Record<BackendKind, { chat: boolean; usage: boolean; skills: boolean }> = {
  'claude-code': { chat: true, usage: true, skills: true },
  opencode: { chat: true, usage: true, skills: true },
  pi: { chat: true, usage: true, skills: true },
  antigravity: { chat: false, usage: false, skills: false },
  grok: { chat: true, usage: false, skills: false },
  kilo: { chat: true, usage: false, skills: false },
}

describe('AGENT_META', () => {
  it('covers every BackendKind, in BACKEND_KINDS order', () => {
    expect(AGENT_META.map((a) => a.kind)).toEqual(BACKEND_KINDS)
  })

  it('matches the verified capability matrix for supportsChat/supportsUsage/supportsSkills', () => {
    for (const meta of AGENT_META) {
      const expected = EXPECTED[meta.kind]
      expect(meta.supportsChat, `${meta.kind}.supportsChat`).toBe(expected.chat)
      expect(meta.supportsUsage, `${meta.kind}.supportsUsage`).toBe(expected.usage)
      expect(meta.supportsSkills, `${meta.kind}.supportsSkills`).toBe(expected.skills)
    }
  })

  it('gives every kind a non-empty label, description, and icon path', () => {
    for (const meta of AGENT_META) {
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(0)
      expect(meta.icon.startsWith('/icons/agents/')).toBe(true)
    }
  })
})

describe('AGENT_LABELS', () => {
  it('has an entry for every BackendKind matching AGENT_META', () => {
    for (const meta of AGENT_META) {
      expect(AGENT_LABELS[meta.kind]).toBe(meta.label)
    }
  })
})
