/**
 * crypto.randomUUID() only exists in a secure context (HTTPS or localhost).
 * Flotilla web is served over plain HTTP across a Tailscale tailnet, so we
 * need a fallback. These ids only correlate WS requests/responses — they
 * don't need to be cryptographically strong.
 */
export function genId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}
