/**
 * agentSkills — discovers `SKILL.md`-convention skill directories for a
 * session's agent (TASK-FPH60 skills listing), routed by BackendKind. Split
 * into pure parsing/merging (unit-tested directly) and a thin async
 * directory-scanning layer (fs access, best-effort — a missing/unreadable
 * dir just contributes no skills, never throws).
 *
 * Per-kind convention:
 *  - claude-code: `<cwd>/.claude/skills/*\/SKILL.md` (project),
 *    `~/.claude/skills/*\/SKILL.md` (user).
 *  - pi:          `<cwd>/.pi/skills/*\/SKILL.md` (project, if present),
 *    `~/.pi/agent/skills/*\/SKILL.md` (user).
 *  - opencode:    probes `<cwd>/.opencode/skill` and `<cwd>/.opencode/skills`
 *    (project — opencode's own docs are inconsistent on the dir name, so both
 *    are tried), `~/.config/opencode/skills` (user).
 *  - antigravity/grok/kilo: no known convention — always [].
 */
import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentSkillDTO, BackendKind } from '../shared/contract.js'

/**
 * Lenient YAML frontmatter parser: pulls only `name:` and `description:`
 * scalar keys out of the leading `---`-delimited block of a SKILL.md file.
 * No YAML library (dependency-free, per the repo's "no mock data" / minimal
 * deps ethos) — single-line `key: value` pairs only, with a single layer of
 * matching quotes stripped. Multi-line/folded values, lists, and nested maps
 * are not supported; a key that isn't a simple scalar is silently skipped
 * (falls back to the dir name / empty description downstream), never throws.
 */
export function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return {}
  const result: { name?: string; description?: string } = {}
  for (const line of match[1].split('\n')) {
    const kv = /^(name|description):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const key = kv[1] as 'name' | 'description'
    let value = kv[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (value) result[key] = value
  }
  return result
}

/** One skill directory's raw material before parsing — kept separate from
 *  the fs read so `skillFromEntry` is pure/unit-testable without touching
 *  disk. */
export interface RawSkillEntry {
  /** The skill's directory name, used as the name fallback when frontmatter
   *  has no `name:` key. */
  dirName: string
  /** Full SKILL.md content, or '' when it couldn't be read (still produces a
   *  dir-name-only DTO — lenient, matches the rest of this codebase's skill
   *  handling, e.g. cliSkillDoc.ts's fallback behavior). */
  content: string
  source: 'project' | 'user'
}

/** Pure: build one AgentSkillDTO from a raw entry, falling back to the dir
 *  name / empty description when frontmatter parsing yields nothing. */
export function skillFromEntry(entry: RawSkillEntry): AgentSkillDTO {
  const fm = parseSkillFrontmatter(entry.content)
  return {
    name: fm.name ?? entry.dirName,
    description: fm.description ?? '',
    source: entry.source,
  }
}

/** Pure: merge project + user skill lists. Project entries win over a user
 *  entry with the same `name` (a worktree-local skill shadows a shared one);
 *  otherwise both contribute, project-first. */
export function mergeSkills(project: AgentSkillDTO[], user: AgentSkillDTO[]): AgentSkillDTO[] {
  const projectNames = new Set(project.map((s) => s.name))
  return [...project, ...user.filter((s) => !projectNames.has(s.name))]
}

/** List every `<dir>/*\/SKILL.md` as AgentSkillDTOs. Best-effort: a missing
 *  or unreadable `dir` (or an unreadable individual SKILL.md, or a dir entry
 *  with no SKILL.md at all — not every subdirectory is a skill) contributes
 *  no entries rather than throwing. */
async function listSkillsInDir(dir: string, source: 'project' | 'user'): Promise<AgentSkillDTO[]> {
  let dirNames: string[]
  try {
    dirNames = await readdir(dir)
  } catch {
    return []
  }
  const out: AgentSkillDTO[] = []
  for (const dirName of dirNames) {
    let content: string
    try {
      content = await readFile(path.join(dir, dirName, 'SKILL.md'), 'utf8')
    } catch {
      continue // not a skill dir (no SKILL.md) — skip, don't fabricate an entry
    }
    out.push(skillFromEntry({ dirName, content, source }))
  }
  return out
}

function claudeSkillDirs(cwd: string): { project: string; user: string } {
  return {
    project: path.join(cwd, '.claude', 'skills'),
    user: path.join(os.homedir(), '.claude', 'skills'),
  }
}

function piSkillDirs(cwd: string): { project: string; user: string } {
  return {
    project: path.join(cwd, '.pi', 'skills'),
    user: path.join(os.homedir(), '.pi', 'agent', 'skills'),
  }
}

function opencodeSkillDirs(cwd: string): { project: string[]; user: string } {
  return {
    // opencode's own docs use both singular and plural for the project dir —
    // probe both; listSkillsInDir already no-ops on a missing one.
    project: [path.join(cwd, '.opencode', 'skill'), path.join(cwd, '.opencode', 'skills')],
    user: path.join(os.homedir(), '.config', 'opencode', 'skills'),
  }
}

/**
 * Resolve the skills available to `agentKind`'s agent in worktree `cwd`,
 * project entries merged over user entries (mergeSkills). [] for backends
 * with no known skills convention.
 */
export async function listAgentSkillsFor(
  agentKind: BackendKind | undefined,
  cwd: string,
): Promise<AgentSkillDTO[]> {
  switch (agentKind ?? 'claude-code') {
    case 'claude-code': {
      const dirs = claudeSkillDirs(cwd)
      const [project, user] = await Promise.all([
        listSkillsInDir(dirs.project, 'project'),
        listSkillsInDir(dirs.user, 'user'),
      ])
      return mergeSkills(project, user)
    }
    case 'pi': {
      const dirs = piSkillDirs(cwd)
      const [project, user] = await Promise.all([
        listSkillsInDir(dirs.project, 'project'),
        listSkillsInDir(dirs.user, 'user'),
      ])
      return mergeSkills(project, user)
    }
    case 'opencode': {
      const dirs = opencodeSkillDirs(cwd)
      const [projectLists, user] = await Promise.all([
        Promise.all(dirs.project.map((d) => listSkillsInDir(d, 'project'))),
        listSkillsInDir(dirs.user, 'user'),
      ])
      return mergeSkills(projectLists.flat(), user)
    }
    default:
      return []
  }
}
