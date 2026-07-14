import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { buildSlipstreamSkillMd } from '../shared/cliSkillDoc.js'

/**
 * Write AGENTS.md to the worktree root so OpenCode auto-discovers it as system prompt.
 * Also ensures AGENTS.md is ignored so it can't be accidentally committed.
 *
 * The ignore entry is written to the local `.git/info/exclude` (NOT the tracked
 * `.gitignore`): `info/exclude` is not versioned, so it never dirties the worktree.
 * Modifying `.gitignore` here previously made every OpenCode worktree report as
 * dirty, which blocked cleanup/removal of OpenCode agent runs (FLO-36).
 */
export function writeAgentsMd(worktreePath: string, content: string): void {
  const agentsMdPath = path.join(worktreePath, 'AGENTS.md')
  fs.writeFileSync(agentsMdPath, content, 'utf8')
  ensureIgnored(worktreePath, 'AGENTS.md')
}

/** Canonical in-worktree skill dir — the agentskills.io open-standard location,
 *  discovered natively by pi and opencode. */
const SKILL_CANONICAL_DIR = path.join('.agents', 'skills', 'slipstream')
/** Claude Code doesn't read `.agents/skills/`, but its docs explicitly support
 *  a skill dir entry that is a symlink — so this links to the canonical dir. */
const SKILL_CLAUDE_LINK = path.join('.claude', 'skills', 'slipstream')

/**
 * Write the `slipstream` CLI skill into a session worktree — ONE canonical
 * copy at `.agents/skills/slipstream/SKILL.md` plus a relative symlink at
 * `.claude/skills/slipstream` for Claude Code (FLO-104). Both paths are added
 * to `.git/info/exclude` (never `.gitignore` — see writeAgentsMd) so the
 * worktree stays clean. Best-effort: any failure is swallowed so a skill-write
 * problem never breaks agent launch. POSIX-only symlink — the app targets
 * Linux/macOS only.
 */
export function writeSlipstreamSkill(worktreePath: string): void {
  try {
    const canonicalDir = path.join(worktreePath, SKILL_CANONICAL_DIR)
    fs.mkdirSync(canonicalDir, { recursive: true })
    fs.writeFileSync(path.join(canonicalDir, 'SKILL.md'), buildSlipstreamSkillMd(), 'utf8')

    const linkPath = path.join(worktreePath, SKILL_CLAUDE_LINK)
    // Relative target so the worktree can move without breaking the link.
    const target = path.relative(path.dirname(linkPath), canonicalDir)
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false })
    if (existing?.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) !== target) {
        fs.unlinkSync(linkPath)
        fs.symlinkSync(target, linkPath)
      }
    } else if (!existing) {
      fs.symlinkSync(target, linkPath)
    }
    // else: a real (repo-owned) dir/file already sits there — leave it alone.

    // Exact patterns only: repos may track their own .claude/skills/* (this
    // one does), so never ignore the parent dirs.
    ensureIgnored(worktreePath, `${SKILL_CANONICAL_DIR}/`)
    ensureIgnored(worktreePath, SKILL_CLAUDE_LINK)
  } catch {
    // best-effort
  }
}

/**
 * Write `opencode.json` at the worktree root with `permission: "allow"` so
 * OpenCode runs don't stall on interactive permission prompts (OpenCode has
 * no `--yolo`-style CLI flag; config is the only supported bypass mechanism —
 * unlike Claude's `--dangerously-skip-permissions` / pi's `--approve`).
 *
 * Only writes when no `opencode.json` already exists at the worktree root — a
 * repo may track its own config, and overwriting it would dirty the worktree
 * and block cleanup, the same worktree-cleanliness hazard as writeAgentsMd's
 * FLO-36 note. When (and only when) we create the file, it's added to
 * `.git/info/exclude` so the worktree stays clean. Best-effort: any failure
 * is swallowed so a config-write problem never breaks agent launch.
 */
export function writeOpencodeConfig(worktreePath: string): void {
  try {
    const configPath = path.join(worktreePath, 'opencode.json')
    if (fs.existsSync(configPath)) return
    const content = `${JSON.stringify(
      { $schema: 'https://opencode.ai/config.json', permission: 'allow' },
      null,
      2,
    )}\n`
    fs.writeFileSync(configPath, content, 'utf8')
    ensureIgnored(worktreePath, 'opencode.json')
  } catch {
    // best-effort
  }
}

/**
 * Write `kilo.jsonc` at the worktree root with `permission: { "*": "allow" }`
 * so Kilo Code TUI runs don't stall on interactive permission prompts — Kilo
 * (an opencode fork) has no CLI bypass flag for the TUI (`--dangerously-skip-
 * permissions`/`--auto` are `kilo run`-only, i.e. headless); config is the
 * only supported mechanism, mirroring writeOpencodeConfig.
 *
 * Only writes when NEITHER `kilo.jsonc` NOR `.kilo/kilo.jsonc` already exists
 * at the worktree root — a repo may track its own config, and `.kilo/
 * kilo.jsonc` takes priority over the root file per Kilo's own docs, so its
 * mere presence also means skip. Overwriting either would dirty the worktree
 * and block cleanup, the same worktree-cleanliness hazard as writeAgentsMd's
 * FLO-36 note. When (and only when) we create the file, it's added to
 * `.git/info/exclude` so the worktree stays clean. Best-effort: any failure
 * is swallowed so a config-write problem never breaks agent launch.
 */
export function writeKiloConfig(worktreePath: string): void {
  try {
    const configPath = path.join(worktreePath, 'kilo.jsonc')
    const nestedConfigPath = path.join(worktreePath, '.kilo', 'kilo.jsonc')
    if (fs.existsSync(configPath) || fs.existsSync(nestedConfigPath)) return
    const content = `${JSON.stringify(
      { $schema: 'https://app.kilo.ai/config.json', permission: { '*': 'allow' } },
      null,
      2,
    )}\n`
    fs.writeFileSync(configPath, content, 'utf8')
    ensureIgnored(worktreePath, 'kilo.jsonc')
  } catch {
    // best-effort
  }
}

/**
 * Resolve the path to a working tree's `.git/info/exclude`. Uses
 * `git rev-parse --git-path` so it's correct for both a plain checkout and a
 * linked worktree (where the exclude file lives in the shared common dir).
 * Returns null when the path can't be determined (not a git tree, git missing).
 */
export function resolveInfoExclude(worktreePath: string): string | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim()
    // git may return a path relative to the worktree cwd; absolutize either way.
    return path.isAbsolute(out) ? out : path.resolve(worktreePath, out)
  } catch {
    return null
  }
}

/**
 * Ensure `pattern` is listed in the local `.git/info/exclude`. Best-effort: any
 * git/fs error is swallowed so a failure to ignore never breaks agent launch.
 */
export function ensureIgnored(worktreePath: string, pattern: string): void {
  try {
    const excludePath = resolveInfoExclude(worktreePath)
    if (!excludePath) return
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
    const lines = existing.split('\n').map((l) => l.trim())
    if (lines.includes(pattern)) return
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(excludePath, `${prefix}${pattern}\n`, 'utf8')
  } catch {
    // best-effort
  }
}
