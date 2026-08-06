/**
 * agentRequestSentinel — pure parser for the requests.ndjson / responses.ndjson
 * sentinel pair (TASK-CIOEQ) that lets a token-free agent session ask the
 * daemon to do privileged things (resolve a repo, launch a new agent, list
 * sibling agents) it otherwise has no channel for. The `slipstream` CLI runs
 * inside the agent's PTY with no daemon auth token, and can only write files
 * under its own session's sentinel dir (`<dataDir>/sessions/<id>/` — the one
 * path bind-mounted rw inside the bwrap sandbox, see agentSandbox.ts): the
 * CLI appends a line to requests.ndjson, the daemon answers by appending a
 * line to responses.ndjson, and the CLI polls/tails that file for its `id`.
 *
 * Dependency-free (usable from both the CLI process and the daemon) and
 * lenient, mirroring agentEventsSentinel.ts: malformed or partially-written
 * trailing lines are skipped, never thrown — the watcher (sentinelWatcher.ts)
 * re-reads the whole file on the next fs event and its own ts-cursor dedupes
 * what was already delivered.
 */

export const AGENT_REQUESTS_FILE = 'requests.ndjson'
export const AGENT_RESPONSES_FILE = 'responses.ndjson'

const VALID_KINDS = ['new-agent', 'repos', 'agents'] as const
type RequestKind = (typeof VALID_KINDS)[number]

/** Ask the daemon to launch a new agent session in a repo the requesting
 *  session's owner has registered. `agent` is a raw, unvalidated BackendKind
 *  string — the consumer (agentSpawnService.ts) validates it against
 *  BACKEND_KINDS and reports ok:false for an unknown value. */
export interface NewAgentRequestLine {
  id: string
  kind: 'new-agent'
  ts: number
  repo: string
  title: string
  prompt: string
  agent?: string
}

/** List repos owned by the requesting session's owner. */
export interface ReposRequestLine {
  id: string
  kind: 'repos'
  ts: number
}

/** List sibling agent sessions spawned from the requesting session. `all`
 *  widens the listing from direct children to the whole spawned-agent
 *  subtree (unset/false = direct children only, today's default behavior).
 *  `tid` switches from a listing to a single-agent detail lookup by tid,
 *  searched across the whole subtree regardless of `all` — a detail lookup
 *  on a grandchild must still work without also passing `all`. */
export interface AgentsRequestLine {
  id: string
  kind: 'agents'
  ts: number
  all?: boolean
  tid?: string
}

export type AgentRequest = NewAgentRequestLine | ReposRequestLine | AgentsRequestLine

/** One responses.ndjson line answering a request by `id`. `data` is
 *  kind-specific (see agentSpawnService.ts) — left as `unknown` here since
 *  this module has no knowledge of the daemon-side shapes it carries. */
export interface AgentResponseOk {
  id: string
  ok: true
  ts: number
  data?: unknown
}

export interface AgentResponseErr {
  id: string
  ok: false
  ts: number
  error: string
}

export type AgentResponse = AgentResponseOk | AgentResponseErr

function parseRequestLine(line: string): AgentRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const id = obj['id']
  if (typeof id !== 'string' || id.length === 0) return null

  const kind = obj['kind']
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as RequestKind)) return null

  const ts = obj['ts']
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null

  if (kind === 'repos') {
    return { id, kind, ts }
  }

  if (kind === 'agents') {
    // Extra fields (`all`/`tid`) were previously dropped silently here — the
    // bare `{ id, kind, ts }` return above discarded anything else the CLI
    // wrote to requests.ndjson before the daemon ever saw it. Stay lenient in
    // this module's established style: a malformed `all`/`tid` is just
    // ignored (falls back to today's direct-children listing), never a parse
    // failure for the whole line.
    const result: AgentsRequestLine = { id, kind: 'agents', ts }
    if (obj['all'] === true) result.all = true
    if (typeof obj['tid'] === 'string' && obj['tid'].length > 0) result.tid = obj['tid']
    return result
  }

  // kind === 'new-agent'
  const repo = obj['repo']
  const title = obj['title']
  const prompt = obj['prompt']
  if (typeof repo !== 'string' || repo.length === 0) return null
  if (typeof title !== 'string' || title.length === 0) return null
  if (typeof prompt !== 'string') return null

  const result: NewAgentRequestLine = { id, kind: 'new-agent', ts, repo, title, prompt }
  if (typeof obj['agent'] === 'string') result.agent = obj['agent'] as string
  return result
}

function parseResponseLine(line: string): AgentResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const id = obj['id']
  if (typeof id !== 'string' || id.length === 0) return null

  const ts = obj['ts']
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null

  const ok = obj['ok']
  if (ok === true) {
    return { id, ok: true, ts, data: obj['data'] }
  }
  if (ok === false) {
    const error = obj['error']
    if (typeof error !== 'string') return null
    return { id, ok: false, ts, error }
  }
  return null
}

/** Parse the full requests.ndjson content, skipping blank/malformed/partial
 *  trailing lines. */
export function parseAgentRequests(raw: string): AgentRequest[] {
  const requests: AgentRequest[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseRequestLine(trimmed)
    if (parsed) requests.push(parsed)
  }
  return requests
}

/** Parse the full responses.ndjson content, skipping blank/malformed/partial
 *  trailing lines. */
export function parseAgentResponses(raw: string): AgentResponse[] {
  const responses: AgentResponse[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseResponseLine(trimmed)
    if (parsed) responses.push(parsed)
  }
  return responses
}
