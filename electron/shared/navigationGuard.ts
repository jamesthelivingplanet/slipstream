/**
 * Decide whether a top-level navigation/redirect target is safe for the app
 * window. Pure + transport-free so it can be unit-tested without Electron.
 *
 * Why this exists (FLO-127): the BrowserWindow's preload
 * (`electron/preload.ts`) exposes the daemon URL + bearer token to whatever
 * document loads in it. `setWindowOpenHandler` only governs *new* windows;
 * an in-place top-level navigation (renderer-side XSS, a stray
 * `window.location = …`, or a server redirect) loads the target origin in
 * the *same* window, where the preload re-runs and hands the credential over.
 * Sandbox/contextIsolation don't help — the token is deliberately exposed to
 * the main world. `main.ts` therefore cancels any navigation off the app
 * origin via `will-navigate` / `will-redirect`, and the preload gates token
 * exposure on this same check as defense in depth.
 *
 * Rules:
 *  - `http(s)://` app URL → allow same-origin targets only. SPA route changes
 *    are history/hash mutations (no navigation), so a real `will-navigate`
 *    off the origin is never legitimate app behavior; same-origin redirects
 *    (e.g. dev-server `/` → `/index.html`) stay allowed.
 *  - `file://` app URL → `file://` has an opaque `'null'` origin shared by
 *    every local document, so an origin compare is useless. Require the exact
 *    app path instead, so a downloaded/local doc can't pull the preload in.
 *  - anything else (`data:`, `blob:`, custom schemes, unparseable) → deny.
 *
 * Importing this file must NOT pull in any Node built-in — it is bundled into
 * the sandboxed CJS preload.
 */
export function isAllowedNavigation(targetUrl: string, appUrl: string): boolean {
  let target: URL
  let app: URL
  try {
    target = new URL(targetUrl)
    app = new URL(appUrl)
  } catch {
    return false
  }

  if (app.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === app.pathname
  }

  if (app.protocol === 'http:' || app.protocol === 'https:') {
    // `origin` (scheme+host+port) normalizes trailing-slash / path differences,
    // so dev-server redirects within the origin stay allowed. Requiring the
    // target to also be http(s) keeps `blob:`/`data:`/`javascript:` out — a
    // `blob:http://localhost:5173/…` URL stringifies to the app origin under
    // the WHATWG spec (its origin is derived from the embedded URL), so an
    // origin-only check would wrongly admit it.
    return (
      (target.protocol === 'http:' || target.protocol === 'https:') && target.origin === app.origin
    )
  }

  return false
}
