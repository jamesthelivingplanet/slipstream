/**
 * opencodeUsage — parses opencode's on-disk message store into the same
 * SessionUsage shape usage.ts produces for Claude Code transcripts (FLO-94
 * parity gap: opencode/pi sessions always showed usage:null).
 *
 * opencode writes one JSON file per message at
 * `<storageRoot>/message/<opencodeSid>/*.json`. Unlike Claude Code's
 * per-turn Anthropic pricing estimate, opencode records its own cost per
 * message — summed as-is, not re-derived from a pricing table.
 *
 * Pure and node-runnable: storageRoot is overridable so this is unit-testable
 * with temp dirs and fixture files.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionUsage, UsageTokens } from '../shared/contract.js'
import { round4 } from './usage.js'

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }

/** Root dir where opencode stores its per-session message JSON files. */
export function opencodeStorageRoot(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode', 'storage')
}

function emptyUsage(sessionId: string): SessionUsage {
  return { sessionId, exists: false, tokens: { ...ZERO_TOKENS }, costUsd: 0, turns: 0 }
}

interface RawOpencodeTokens {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

interface RawOpencodeMessage {
  role?: unknown
  tokens?: RawOpencodeTokens
  cost?: unknown
  modelID?: unknown
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Parse a single session's opencode message store into a token + cost
 * rollup. Returns `exists: false` with zeroed tokens when there's no sid, no
 * message dir, or the dir is unreadable. Unparseable files are skipped
 * silently (mirrors readTranscriptUsage's tolerance of partial/garbage data).
 */
export function readOpencodeUsage(
  sessionId: string,
  opencodeSid: string | undefined,
  storageRoot: string = opencodeStorageRoot(),
): SessionUsage {
  if (!opencodeSid) return emptyUsage(sessionId)

  const dir = path.join(storageRoot, 'message', opencodeSid)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return emptyUsage(sessionId)
  }

  let tokens = { ...ZERO_TOKENS }
  let cost = 0
  let turns = 0
  let model: string | undefined

  for (const file of files) {
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const msg = raw as RawOpencodeMessage
    if (msg.role !== 'assistant') continue
    if (!msg.tokens || typeof msg.tokens !== 'object') continue

    const t = msg.tokens
    tokens = {
      input: tokens.input + n(t.input),
      output: tokens.output + n(t.output) + n(t.reasoning),
      cacheCreation: tokens.cacheCreation + n(t.cache?.write),
      cacheRead: tokens.cacheRead + n(t.cache?.read),
    }
    cost += n(msg.cost)
    turns++
    if (typeof msg.modelID === 'string' && msg.modelID) model = msg.modelID
  }

  return {
    sessionId,
    exists: true,
    tokens,
    costUsd: round4(cost),
    turns,
    model,
  }
}
