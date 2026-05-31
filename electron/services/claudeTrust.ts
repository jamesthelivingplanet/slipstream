/**
 * claudeTrust — pre-seeds the workspace-trust flag in ~/.claude.json so that
 * Claude Code does not show a "Do you trust the files in this folder?" dialog
 * when spawned in a fresh worktree directory.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── Pure helper (exported for unit tests) ────────────────────────────────────

/**
 * Returns a NEW config object with `config.projects[dir].hasTrustDialogAccepted`
 * set to `true`. All other keys at every level are preserved. Input is not mutated.
 */
export function withTrustedDir(
  config: Record<string, unknown>,
  dir: string,
): Record<string, unknown> {
  const existingProjects =
    config.projects !== null && typeof config.projects === 'object'
      ? (config.projects as Record<string, unknown>)
      : {}

  const existingEntry =
    existingProjects[dir] !== null && typeof existingProjects[dir] === 'object'
      ? (existingProjects[dir] as Record<string, unknown>)
      : {}

  return {
    ...config,
    projects: {
      ...existingProjects,
      [dir]: {
        ...existingEntry,
        hasTrustDialogAccepted: true,
      },
    },
  }
}

// ─── Effectful writer ─────────────────────────────────────────────────────────

/**
 * Reads ~/.claude.json, applies withTrustedDir, and atomically writes it back.
 * Best-effort: swallows all errors so it can never block session start.
 */
export function trustDirectory(dir: string): void {
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')

    let config: Record<string, unknown> = {}
    if (fs.existsSync(claudeJsonPath)) {
      const raw = fs.readFileSync(claudeJsonPath, 'utf8')
      config = JSON.parse(raw) as Record<string, unknown>
    }

    const updated = withTrustedDir(config, dir)

    const tmpPath = path.join(
      os.homedir(),
      `.claude.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    )
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
    fs.renameSync(tmpPath, claudeJsonPath)
  } catch (err) {
    console.warn('[claudeTrust] could not update ~/.claude.json:', err)
  }
}
