import { describe, it, expect } from 'vitest'
import {
  parseRemote,
  gitlabProjectPath,
  redact,
  buildGitlabCreateMrDescriptor,
  buildGitlabFindMrDescriptor,
  buildGithubCreatePrDescriptor,
  buildGithubFindPrDescriptor,
} from './gitDriver.js'

describe('parseRemote', () => {
  it('parses ssh gitlab', () => {
    expect(parseRemote('git@gitlab.com:org/name.git')).toEqual({
      host: 'gitlab',
      org: 'org',
      name: 'name',
    })
  })
  it('parses ssh github', () => {
    expect(parseRemote('git@github.com:org/name.git')).toEqual({
      host: 'github',
      org: 'org',
      name: 'name',
    })
  })
  it('parses https gitlab', () => {
    expect(parseRemote('https://gitlab.com/org/name.git')).toEqual({
      host: 'gitlab',
      org: 'org',
      name: 'name',
    })
  })
  it('parses https github without .git', () => {
    expect(parseRemote('https://github.com/org/name')).toEqual({
      host: 'github',
      org: 'org',
      name: 'name',
    })
  })
  it('returns null for unknown host', () => {
    // bitbucket.org matches since TASK-7LGAO; use a domain no provider claims
    // (gitea needs a configured baseUrl, which config-less parseRemote never has).
    expect(parseRemote('https://git.example.com/org/name')).toBeNull()
  })
  it('returns null for bad url', () => {
    expect(parseRemote('not-a-url')).toBeNull()
  })
})

describe('gitlabProjectPath', () => {
  it('encodes org/name with slash', () => {
    expect(gitlabProjectPath('my-org', 'my-repo')).toBe(encodeURIComponent('my-org/my-repo'))
  })
})

describe('redact', () => {
  it('replaces token in string', () => {
    expect(redact('Bearer abc123 and abc123', 'abc123')).toBe('Bearer *** and ***')
  })
  it('returns string unchanged when token is empty', () => {
    expect(redact('some string', '')).toBe('some string')
  })
})

describe('buildGitlabCreateMrDescriptor', () => {
  it('url contains project path and no token', () => {
    const d = buildGitlabCreateMrDescriptor({
      org: 'o',
      name: 'n',
      branch: 'b',
      base: 'main',
      title: 't',
      description: 'd',
      token: 'tok',
    })
    expect(d.method).toBe('POST')
    expect(d.url).not.toContain('tok')
    expect(d.headers['PRIVATE-TOKEN']).toBe('tok')
  })
})

describe('buildGitlabFindMrDescriptor', () => {
  it('url does not contain token', () => {
    const d = buildGitlabFindMrDescriptor({ org: 'o', name: 'n', branch: 'b', token: 'tok' })
    expect(d.method).toBe('GET')
    expect(d.url).not.toContain('tok')
    expect(d.headers['PRIVATE-TOKEN']).toBe('tok')
  })
})

describe('buildGithubCreatePrDescriptor', () => {
  it('url does not contain token', () => {
    const d = buildGithubCreatePrDescriptor({
      org: 'o',
      name: 'n',
      branch: 'b',
      base: 'main',
      title: 't',
      body: '',
      token: 'tok',
    })
    expect(d.method).toBe('POST')
    expect(d.url).not.toContain('tok')
    expect(d.headers['Authorization']).toContain('tok')
  })
})

describe('buildGithubFindPrDescriptor', () => {
  it('url does not contain token', () => {
    const d = buildGithubFindPrDescriptor({
      org: 'o',
      name: 'n',
      org_login: 'o',
      branch: 'b',
      token: 'tok',
    })
    expect(d.method).toBe('GET')
    expect(d.url).not.toContain('tok')
    expect(d.headers['Authorization']).toContain('tok')
  })
})
