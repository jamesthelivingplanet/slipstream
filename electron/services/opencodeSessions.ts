export interface OpencodeSession {
  id: string
  time_created?: number
  time_updated?: number
  title?: string
}

/**
 * Pure: newest session id whose time_created >= sinceMs, or null.
 * Exported so selection logic is unit-tested without network access.
 */
export function selectNewestSessionSince(
  sessions: OpencodeSession[],
  sinceMs: number,
): string | null {
  let best: OpencodeSession | null = null
  for (const s of sessions) {
    const t = s.time_created ?? 0
    if (t >= sinceMs && (!best || t > (best.time_created ?? 0))) {
      best = s
    }
  }
  return best?.id ?? null
}

/**
 * Fetch the session list from an opencode TUI's embedded server (launched with
 * --port). Returns [] on any error (server still starting, unreachable, etc.).
 */
export async function listOpencodeSessions(port: number): Promise<OpencodeSession[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`)
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? (data as OpencodeSession[]) : []
  } catch {
    return []
  }
}

/**
 * Poll the opencode server for the session id created at/after sinceMs. The TUI
 * creates its session shortly after launch (and on first message), so this
 * retries until the server is up and the session appears, or attempts run out.
 */
export async function captureOpencodeSessionId(
  port: number,
  sinceMs: number,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? 20
  const intervalMs = opts.intervalMs ?? 500
  for (let i = 0; i < attempts; i++) {
    const id = selectNewestSessionSince(await listOpencodeSessions(port), sinceMs)
    if (id) return id
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}
