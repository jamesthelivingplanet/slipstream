import { describe, it, expect } from 'vitest'
import { detectSlashToken, filterSkills, applySlashSelection } from './chatSlash.js'
import type { AgentSkillDTO } from '../../electron/shared/contract.js'

function skill(
  name: string,
  description: string,
  source: AgentSkillDTO['source'] = 'project',
): AgentSkillDTO {
  return { name, description, source }
}

describe('detectSlashToken', () => {
  it('returns null for an empty draft', () => {
    expect(detectSlashToken('')).toBeNull()
  })

  it('returns null when the draft does not start with /', () => {
    expect(detectSlashToken('hello')).toBeNull()
    expect(detectSlashToken('hi /deploy')).toBeNull()
  })

  it('returns a token with an empty query for a bare slash', () => {
    expect(detectSlashToken('/')).toEqual({ query: '', start: 0, end: 1 })
  })

  it('returns a token with the text typed after the slash', () => {
    expect(detectSlashToken('/dep')).toEqual({ query: 'dep', start: 0, end: 4 })
  })

  it('returns null once a space is typed — the command is committed', () => {
    expect(detectSlashToken('/deploy ')).toBeNull()
    expect(detectSlashToken('/deploy staging')).toBeNull()
  })

  it('returns null for internal whitespace like a newline mid-token', () => {
    expect(detectSlashToken('/de\nploy')).toBeNull()
  })
})

describe('filterSkills', () => {
  const skills = [
    skill('deploy', 'Deploy the app'),
    skill('deploy-staging', 'Deploy to staging', 'user'),
    skill('debug', 'Start a debug session'),
    skill('review', 'Review a PR'),
  ]

  it('returns every skill for an empty query', () => {
    expect(filterSkills(skills, '')).toEqual(skills)
  })

  it('filters by case-insensitive name prefix', () => {
    expect(filterSkills(skills, 'dep').map((s) => s.name)).toEqual(['deploy', 'deploy-staging'])
    expect(filterSkills(skills, 'DEP').map((s) => s.name)).toEqual(['deploy', 'deploy-staging'])
  })

  it('excludes skills whose name does not start with the query', () => {
    expect(filterSkills(skills, 'eploy')).toEqual([])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([])
  })

  it('returns an empty array for an empty skills list', () => {
    expect(filterSkills([], 'deploy')).toEqual([])
  })
})

describe('applySlashSelection', () => {
  it('replaces a whole-draft token with /name and a trailing space', () => {
    const token = { query: 'dep', start: 0, end: 4 }
    expect(applySlashSelection('/dep', token, 'deploy')).toBe('/deploy ')
  })

  it('replaces a bare-slash token', () => {
    const token = { query: '', start: 0, end: 1 }
    expect(applySlashSelection('/', token, 'review')).toBe('/review ')
  })

  it('preserves text after the token end', () => {
    const token = { query: 'dep', start: 0, end: 4 }
    expect(applySlashSelection('/dep extra', token, 'deploy')).toBe('/deploy  extra')
  })
})
