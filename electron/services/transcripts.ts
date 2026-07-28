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

/** One subagent (Task/Agent-tool) transcript belonging to a session. */
export interface SubagentTranscriptFile {
  /** Short hex id embedded in the filename (`agent-<agentId>.jsonl`) and in
   *  the transcript's own `agentId` field. */
  agentId: string
  /** Path to the subagent's own JSONL transcript. */
  jsonlPath: string
  /** Path to the sibling `agent-<agentId>.meta.json`, or null when absent.
   *  When present it carries `toolUseId` — the id of the `Agent` tool_use
   *  (verified against real transcripts on this machine: the subagent-
   *  spawning tool is named `Agent`, not `Task`) that spawned this subagent,
   *  used for threading it back to its parent turn. */
  metaPath: string | null
}

/**
 * Directory holding a Claude Code session's subagent transcripts
 * (sibling to the main `<sessionId>.jsonl` resolved by `transcriptPathFor`),
 * or null when none exists — either no subagents were ever spawned in this
 * session, or `projectsDir` has no matching session at all. Same resolution
 * strategy as `transcriptPathFor`: scan project subdirs rather than reproduce
 * Claude's cwd-path encoding, since session ids are globally unique UUIDs.
 */
export function subagentsDirFor(
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
    const candidate = path.join(projectsDir, sub, id, 'subagents')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * List a session's subagent transcript files (`agent-*.jsonl`), unordered —
 * callers merge by each message's `ts`. Returns [] when there's no subagents
 * dir, or it can't be read (never throws). Every Task/Agent-tool subagent
 * turn lives in its own `<sessionId>/subagents/agent-<agentId>.jsonl` file,
 * NOT inline in the main transcript (verified against 108 real sessions on
 * this machine) — see `transcriptMessages.ts`'s module doc.
 */
export function subagentTranscriptFiles(
  id: string,
  projectsDir: string = claudeProjectsDir(),
): SubagentTranscriptFile[] {
  const dir = subagentsDirFor(id, projectsDir)
  if (!dir) return []
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const files: SubagentTranscriptFile[] = []
  for (const name of names) {
    const match = /^agent-(.+)\.jsonl$/.exec(name)
    if (!match) continue
    const agentId = match[1]
    const jsonlPath = path.join(dir, name)
    const metaCandidate = path.join(dir, `agent-${agentId}.meta.json`)
    const metaPath = fs.existsSync(metaCandidate) ? metaCandidate : null
    files.push({ agentId, jsonlPath, metaPath })
  }
  return files
}
