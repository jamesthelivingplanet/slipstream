import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Root dir where Claude Code stores per-project transcripts. */
export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

/**
 * Resolve the path of a Claude Code transcript (<id>.jsonl) for this session
 * id under any project dir, or null when none exists. Session ids are
 * globally unique UUIDs, so we scan project subdirs rather than reproduce
 * Claude's cwd-path encoding. Also used by the usage parser (FLO-94).
 */
export function transcriptPathFor(
  id: string,
  projectsDir: string = claudeProjectsDir(),
): string | null {
  let subs: string[]
  try {
    subs = fs.readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const sub of subs) {
    const candidate = path.join(projectsDir, sub, `${id}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * True if a Claude Code transcript (<id>.jsonl) exists for this session id under
 * any project dir.
 */
export function hasTranscript(id: string, projectsDir: string = claudeProjectsDir()): boolean {
  return transcriptPathFor(id, projectsDir) !== null
}
