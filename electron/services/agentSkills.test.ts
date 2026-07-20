import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseSkillFrontmatter,
  skillFromEntry,
  mergeSkills,
  listAgentSkillsFor,
} from './agentSkills.js'

// ─── parseSkillFrontmatter ───────────────────────────────────────────────────

describe('parseSkillFrontmatter', () => {
  it('extracts name and description from a frontmatter block', () => {
    const raw = [
      '---',
      'name: my-skill',
      'description: Does a thing',
      '---',
      '',
      'Body text.',
    ].join('\n')
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'my-skill',
      description: 'Does a thing',
    })
  })

  it('strips a single layer of matching double quotes', () => {
    const raw = ['---', 'name: "quoted-name"', 'description: "A quoted description"', '---'].join(
      '\n',
    )
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'quoted-name',
      description: 'A quoted description',
    })
  })

  it('strips a single layer of matching single quotes', () => {
    const raw = ['---', "name: 'single-quoted'", '---'].join('\n')
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'single-quoted' })
  })

  it('returns {} when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('Just a plain SKILL.md with no frontmatter.')).toEqual({})
  })

  it('ignores unrelated keys', () => {
    const raw = ['---', 'name: my-skill', 'author: someone', 'version: 1', '---'].join('\n')
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'my-skill' })
  })

  it('returns {} for an empty frontmatter block', () => {
    expect(parseSkillFrontmatter('---\n---\nbody')).toEqual({})
  })

  it('ignores an empty value', () => {
    const raw = ['---', 'name:', 'description: real description', '---'].join('\n')
    expect(parseSkillFrontmatter(raw)).toEqual({ description: 'real description' })
  })

  it('handles CRLF line endings', () => {
    const raw = '---\r\nname: crlf-skill\r\n---\r\n'
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'crlf-skill' })
  })
})

// ─── skillFromEntry ──────────────────────────────────────────────────────────

describe('skillFromEntry', () => {
  it('uses frontmatter name/description when present', () => {
    const content = ['---', 'name: real-name', 'description: real desc', '---'].join('\n')
    expect(skillFromEntry({ dirName: 'dir-name', content, source: 'project' })).toEqual({
      name: 'real-name',
      description: 'real desc',
      source: 'project',
    })
  })

  it('falls back to dirName and empty description with no frontmatter', () => {
    expect(skillFromEntry({ dirName: 'my-dir', content: '', source: 'user' })).toEqual({
      name: 'my-dir',
      description: '',
      source: 'user',
    })
  })

  it('falls back to dirName when only description is present', () => {
    const content = ['---', 'description: only desc', '---'].join('\n')
    expect(skillFromEntry({ dirName: 'fallback-name', content, source: 'user' })).toEqual({
      name: 'fallback-name',
      description: 'only desc',
      source: 'user',
    })
  })
})

// ─── mergeSkills ─────────────────────────────────────────────────────────────

describe('mergeSkills', () => {
  it('concatenates project and user when there is no name collision', () => {
    const project = [{ name: 'a', description: '', source: 'project' as const }]
    const user = [{ name: 'b', description: '', source: 'user' as const }]
    expect(mergeSkills(project, user)).toEqual([...project, ...user])
  })

  it('project entry wins over a user entry with the same name', () => {
    const project = [{ name: 'shared', description: 'project version', source: 'project' as const }]
    const user = [{ name: 'shared', description: 'user version', source: 'user' as const }]
    expect(mergeSkills(project, user)).toEqual([
      { name: 'shared', description: 'project version', source: 'project' },
    ])
  })

  it('returns [] for two empty lists', () => {
    expect(mergeSkills([], [])).toEqual([])
  })
})

// ─── listAgentSkillsFor (fs integration) ────────────────────────────────────

describe('listAgentSkillsFor', () => {
  let root: string
  let cwd: string
  let homeDir: string
  let prevHome: string | undefined

  function writeSkill(dir: string, name: string, frontmatter?: string): void {
    const skillDir = path.join(dir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      frontmatter ?? `---\nname: ${name}\ndescription: desc for ${name}\n---\n`,
    )
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-agent-skills-'))
    cwd = path.join(root, 'worktree')
    homeDir = path.join(root, 'home')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(homeDir, { recursive: true })
    prevHome = process.env.HOME
    process.env.HOME = homeDir
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('claude-code: merges project (.claude/skills) and user (~/.claude/skills)', async () => {
    writeSkill(path.join(cwd, '.claude', 'skills'), 'project-skill')
    writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-skill')

    const result = await listAgentSkillsFor('claude-code', cwd)
    expect(result).toEqual(
      expect.arrayContaining([
        { name: 'project-skill', description: 'desc for project-skill', source: 'project' },
        { name: 'user-skill', description: 'desc for user-skill', source: 'user' },
      ]),
    )
    expect(result).toHaveLength(2)
  })

  it('claude-code: project entry wins on a name collision', async () => {
    writeSkill(
      path.join(cwd, '.claude', 'skills'),
      'shared',
      '---\nname: shared\ndescription: project\n---\n',
    )
    writeSkill(
      path.join(homeDir, '.claude', 'skills'),
      'shared',
      '---\nname: shared\ndescription: user\n---\n',
    )

    const result = await listAgentSkillsFor('claude-code', cwd)
    expect(result).toEqual([{ name: 'shared', description: 'project', source: 'project' }])
  })

  it('claude-code: defaults to this kind when agentKind is undefined', async () => {
    writeSkill(path.join(cwd, '.claude', 'skills'), 'default-kind')
    const result = await listAgentSkillsFor(undefined, cwd)
    expect(result).toEqual([
      { name: 'default-kind', description: 'desc for default-kind', source: 'project' },
    ])
  })

  it('pi: reads .pi/skills (project) and ~/.pi/agent/skills (user)', async () => {
    writeSkill(path.join(cwd, '.pi', 'skills'), 'pi-project-skill')
    writeSkill(path.join(homeDir, '.pi', 'agent', 'skills'), 'pi-user-skill')

    const result = await listAgentSkillsFor('pi', cwd)
    expect(result).toEqual(
      expect.arrayContaining([
        { name: 'pi-project-skill', description: 'desc for pi-project-skill', source: 'project' },
        { name: 'pi-user-skill', description: 'desc for pi-user-skill', source: 'user' },
      ]),
    )
    expect(result).toHaveLength(2)
  })

  it('pi: [] when neither project nor user dir exists', async () => {
    expect(await listAgentSkillsFor('pi', cwd)).toEqual([])
  })

  it('opencode: probes both .opencode/skill and .opencode/skills for project entries', async () => {
    writeSkill(path.join(cwd, '.opencode', 'skill'), 'singular-dir-skill')
    writeSkill(path.join(cwd, '.opencode', 'skills'), 'plural-dir-skill')
    writeSkill(path.join(homeDir, '.config', 'opencode', 'skills'), 'opencode-user-skill')

    const result = await listAgentSkillsFor('opencode', cwd)
    expect(result.map((s) => s.name).sort()).toEqual([
      'opencode-user-skill',
      'plural-dir-skill',
      'singular-dir-skill',
    ])
  })

  it('opencode: [] when no probed dir exists', async () => {
    expect(await listAgentSkillsFor('opencode', cwd)).toEqual([])
  })

  it.each(['antigravity', 'grok', 'kilo'] as const)(
    '%s: always returns [] (no known skills convention)',
    async (kind) => {
      writeSkill(path.join(cwd, '.claude', 'skills'), 'irrelevant')
      expect(await listAgentSkillsFor(kind, cwd)).toEqual([])
    },
  )

  it('ignores a subdirectory with no SKILL.md', async () => {
    const skillsDir = path.join(cwd, '.claude', 'skills')
    fs.mkdirSync(path.join(skillsDir, 'not-a-skill'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'not-a-skill', 'README.md'), 'nope')
    expect(await listAgentSkillsFor('claude-code', cwd)).toEqual([])
  })
})
