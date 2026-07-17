// Helpers for the TokenGate's "server URL" field and for deriving the RPC
// WebSocket endpoint from an http(s) server origin. Framework-free so both
// TokenGate.svelte and main.ts (dynamic import, see boot-sequence comment in
// main.ts) can use it without pulling in Svelte.

/**
 * Normalize user input into an http(s) origin, or null if unparseable.
 * Bare `host[:port]` input gets the page protocol prefixed (default 'http:').
 * Any path/query/hash the user pasted is dropped — only the origin survives.
 */
export function normalizeServerUrl(raw: string, pageProtocol = 'http:'): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const withProtocol = trimmed.includes('://') ? trimmed : `${pageProtocol}//${trimmed}`

  let u: URL
  try {
    u = new URL(withProtocol)
  } catch {
    return null
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  return u.origin
}

/** ws(s)://host[:port]/rpc endpoint for an http(s) server origin. */
export function rpcWsUrl(serverOrigin: string): string {
  const u = new URL(serverOrigin)
  const proto = u.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${u.host}/rpc`
}
