/**
 * Usage — FLO-94. Parses Claude Code transcript JSONL per-turn usage data into
 * token + cost rollups per session, repo, and day. Gives mission control a real
 * cost signal instead of the idle reaper as a proxy.
 *
 * Pure and node-runnable: takes the projects dir explicitly (defaults to
 * claudeProjectsDir()) so it's unit-testable with temp dirs and fixture files.
 *
 * Cost is an ESTIMATE. The token counts are authoritative (read straight from
 * the transcript's per-turn usage object); dollars are derived from the
 * model-family pricing table below. List prices drift over time — keep the
 * table as a single editable constant.
 */
import fs from 'node:fs'
import { claudeProjectsDir, transcriptPathFor } from './transcripts.js'
import { dayKeyFromMs } from '../shared/usageFormat.js'
import { readOpencodeUsage } from './opencodeUsage.js'
import { readPiUsage } from './piUsage.js'
import type {
  SessionDTO,
  SessionUsage,
  UsageBucket,
  UsageSummary,
  UsageTokens,
} from '../shared/contract.js'

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }

/** Per-1M-token list prices (USD) for each Anthropic model family. Cache write
 *  is charged at the 5-minute ephemeral rate (the common case; the 1h rate is
 *  higher, so this is a slight underestimate when 1h caching is used). Update
 *  here when prices change — there is no other copy. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku'

interface ModelPricing {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const PRICING: Record<ModelFamily, ModelPricing> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
}

/** Map a Claude model alias (e.g. "claude-opus-4-8", "sonnet", "<synthetic>")
 *  to a pricing family. Unknowns default to sonnet — the Claude Code default
 *  and a reasonable middle estimate. */
export function familyForModel(model: string | undefined | null): ModelFamily {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('haiku')) return 'haiku'
  return 'sonnet'
}

/** Estimated USD cost for one turn's tokens given its model alias. */
function costForTurn(tokens: UsageTokens, model: string | undefined): number {
  const p = PRICING[familyForModel(model)]
  const per = 1_000_000
  return (
    (tokens.input / per) * p.input +
    (tokens.output / per) * p.output +
    (tokens.cacheCreation / per) * p.cacheWrite +
    (tokens.cacheRead / per) * p.cacheRead
  )
}

/** Round to 4 dp so serialized JSON doesn't carry float noise. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function addTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  }
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** Pull the four canonical token counts out of a transcript turn's usage
 *  object. Missing/non-numeric fields count as 0. */
function tokensFromUsage(raw: unknown): UsageTokens {
  if (!raw || typeof raw !== 'object') return { ...ZERO_TOKENS }
  const u = raw as RawUsage
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheCreation: n(u.cache_creation_input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
  }
}

/**
 * Parse a single session's transcript JSONL into a token + cost rollup.
 * Sums every assistant turn's top-level `message.usage` (Claude Code's own
 * cost tracking uses these same fields; the nested `iterations` array is a
 * duplicate and is intentionally not double-counted). Returns `exists: false`
 * with zeroed tokens when no transcript file is present yet.
 */
export function readTranscriptUsage(
  id: string,
  projectsDir: string = claudeProjectsDir(),
): SessionUsage {
  const file = transcriptPathFor(id, projectsDir)
  if (!file) {
    return {
      sessionId: id,
      exists: false,
      tokens: { ...ZERO_TOKENS },
      costUsd: 0,
      turns: 0,
    }
  }

  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {
      sessionId: id,
      exists: false,
      tokens: { ...ZERO_TOKENS },
      costUsd: 0,
      turns: 0,
    }
  }

  let tokens = { ...ZERO_TOKENS }
  let cost = 0
  let turns = 0
  let model: string | undefined

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue // transcripts can contain partial/append-in-progress lines
    }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { type?: unknown; message?: unknown }
    if (e.type !== 'assistant') continue
    if (!e.message || typeof e.message !== 'object') continue
    const msg = e.message as { usage?: unknown; model?: unknown }
    if (!msg.usage) continue

    const t = tokensFromUsage(msg.usage)
    tokens = addTokens(tokens, t)
    cost += costForTurn(t, typeof msg.model === 'string' ? msg.model : undefined)
    turns++
    if (typeof msg.model === 'string' && msg.model) model = msg.model
  }

  return {
    sessionId: id,
    exists: true,
    tokens,
    costUsd: round4(cost),
    turns,
    model,
  }
}

/** Empty (no data yet) usage shape shared by any kind with no reader. */
function emptyUsage(sessionId: string): SessionUsage {
  return { sessionId, exists: false, tokens: { ...ZERO_TOKENS }, costUsd: 0, turns: 0 }
}

/**
 * Dispatch to the right per-backend usage reader based on `session.agentKind`
 * (defaults to 'claude-code' for legacy sessions with no recorded kind), so
 * every backend produces the same SessionUsage contract shape (FLO-94 parity
 * gap: opencode/pi sessions always showed usage:null).
 */
export function readSessionUsage(
  session: SessionDTO,
  opts: {
    projectsDir?: string
    opencodeRoot?: string
    piRoot?: string
    cwd?: string | null
  } = {},
): SessionUsage {
  const kind = session.agentKind ?? 'claude-code'
  switch (kind) {
    case 'claude-code':
      return readTranscriptUsage(session.id, opts.projectsDir)
    case 'opencode':
      return readOpencodeUsage(session.id, session.opencodeSid, opts.opencodeRoot)
    case 'pi':
      return readPiUsage(session.id, opts.cwd ?? null, opts.piRoot)
    default:
      // 'antigravity' / 'grok': no documented on-disk usage format yet.
      // 'kilo': stores sessions in a SQLite `~/.local/share/kilo/kilo.db`
      // (not opencode's file-per-message store), so `readOpencodeUsage` can't
      // be reused as-is — a reader can be added later (e.g. via `kilo export
      // <sessionID>` / `kilo stats`), same shape as the others once it exists.
      return emptyUsage(session.id)
  }
}

/**
 * Build a total + by-repo + by-day usage rollup across the given sessions.
 * Sessions without usage data yet are skipped (they contribute nothing).
 * Repo buckets are keyed by repoId; day buckets by 'YYYY-MM-DD' derived from
 * each session's createdAt (the day the run started).
 */
export function buildUsageSummary(
  sessions: SessionDTO[],
  opts: {
    projectsDir?: string
    opencodeRoot?: string
    piRoot?: string
    cwdFor?: (s: SessionDTO) => string | null
  } = {},
): UsageSummary {
  const perSession: SessionUsage[] = []
  const byRepo = new Map<string, UsageBucket>()
  const byDay = new Map<string, UsageBucket>()
  let total = { ...ZERO_TOKENS }
  let totalCost = 0

  for (const s of sessions) {
    const u = readSessionUsage(s, {
      projectsDir: opts.projectsDir,
      opencodeRoot: opts.opencodeRoot,
      piRoot: opts.piRoot,
      cwd: opts.cwdFor?.(s) ?? null,
    })
    if (!u.exists) continue
    if (u.turns === 0) continue // transcript exists but no usage yet — nothing to count

    perSession.push(u)
    total = addTokens(total, u.tokens)
    totalCost += u.costUsd

    const repo = byRepo.get(s.repoId) ?? {
      key: s.repoId,
      tokens: { ...ZERO_TOKENS },
      costUsd: 0,
      sessions: 0,
    }
    repo.tokens = addTokens(repo.tokens, u.tokens)
    repo.costUsd += u.costUsd
    repo.sessions += 1
    byRepo.set(s.repoId, repo)

    const dayKey = dayKeyFromMs(s.createdAt)
    const day = byDay.get(dayKey) ?? {
      key: dayKey,
      tokens: { ...ZERO_TOKENS },
      costUsd: 0,
      sessions: 0,
    }
    day.tokens = addTokens(day.tokens, u.tokens)
    day.costUsd += u.costUsd
    day.sessions += 1
    byDay.set(dayKey, day)
  }

  return {
    total,
    costUsd: round4(totalCost),
    byRepo: [...byRepo.values()].sort(
      (a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key),
    ),
    byDay: [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key)),
    sessions: perSession.sort((a, b) => b.costUsd - a.costUsd),
  }
}
