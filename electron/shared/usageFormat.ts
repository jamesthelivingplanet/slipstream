/**
 * Pure usage-formatting helpers shared between the node-side usage parser
 * (electron/services/usage.ts) and the renderer (mission control). Importing
 * this file must NOT pull in any Node built-in — it is bundled into the
 * renderer, which runs in a sandboxed browser context.
 */

/** 'YYYY-MM-DD' (UTC) for an epoch-ms timestamp. UTC keeps day buckets stable
 *  across machines and matches Claude Code's ISO-8601 transcript timestamps. */
export function dayKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Compact human token count: 999 → '999', 1200 → '1.2k', 3_400_000 → '3.4M'. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return (k < 100 ? k.toFixed(k < 10 ? 1 : 0) : Math.round(k).toString()) + 'k'
  }
  const m = n / 1_000_000
  return (m < 100 ? m.toFixed(m < 10 ? 1 : 0) : Math.round(m).toString()) + 'M'
}

/** Compact USD cost estimate. Dollar amounts stay readable at any scale:
 *  0 → '$0', 0.004 → '<$0.01', 0.42 → '$0.42', 3.5 → '$3.50', 42 → '$42',
 *  42.6 → '$42.6', 1234 → '$1.2k', 99999 → '$100k'. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return '$' + usd.toFixed(2)
  if (usd < 1000) {
    const v = Math.round(usd * 10) / 10
    return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(1)}`
  }
  const k = usd / 1000
  const v = Math.round(k * 10) / 10
  return Number.isInteger(v) ? `$${v}k` : `$${v.toFixed(1)}k`
}
