import './app.css'
import '@xterm/xterm/css/xterm.css'

/**
 * Boot sequence.
 *
 * Electron: window.slipstream is already set by the preload. We just mount App.
 *
 * Web/browser: window.slipstream is absent. We must:
 *   1. Resolve the server origin — a stored override (DAEMON_URL_KEY) if the
 *      user previously pointed the gate at a different host, else
 *      location.origin (the SPA's own host, the historical default) — and
 *      derive the RPC WS URL from it.
 *   2. Determine the token.
 *   3. If no token → show TokenGate (collects both server URL + token; wait
 *      for user to submit).
 *   4. Create the WS-backed SlipstreamApi and assign window.slipstream BEFORE
 *      importing App (and therefore ipc.ts), so `hasBackend` evaluates true.
 *
 * The dynamic import() approach guarantees that ipc.ts runs its module-level
 * `hasBackend = !!window.slipstream` AFTER we set window.slipstream.
 */

const target = document.getElementById('app')!

// The single Svelte component currently mounted into #app (App or TokenGate).
// We swap between them on (re)auth and always destroy the previous one so an
// auth failure can never leave the app and the gate stacked in the same target.
let mounted: { $destroy(): void } | null = null

function clearMount(): void {
  if (mounted) {
    mounted.$destroy()
    mounted = null
  }
}

async function mountApp(shouldAbort?: () => boolean) {
  const { default: App } = await import('./App.svelte')
  // If auth failed while we were importing, don't mount the app over the gate.
  if (shouldAbort?.()) return
  clearMount()
  mounted = new App({ target })
}

async function bootWeb() {
  const { createWsApi } = await import('./lib/wsApi.js')
  const { nativeStorage, TOKEN_KEY, DAEMON_URL_KEY } = await import('./lib/nativeStorage.js')
  const { rpcWsUrl } = await import('./lib/serverUrl.js')

  // -- Token resolution --
  // Priority: ?token= query param > nativeStorage facade (secure storage /
  // Preferences inside the Capacitor mobile shell, localStorage elsewhere —
  // see nativeStorage.ts). A pre-existing legacy localStorage token (the
  // WebView had no native storage before TASK-I9S44) is migrated forward
  // the first time nothing is found under the new key.
  const params = new URLSearchParams(location.search)
  const paramToken = params.get('token')
  if (paramToken) {
    await nativeStorage.set(TOKEN_KEY, paramToken)
    // Strip the token from the URL bar (cosmetic + security)
    params.delete('token')
    const clean = params.toString()
    const newUrl = location.pathname + (clean ? `?${clean}` : '') + location.hash
    history.replaceState(null, '', newUrl)
  }

  await nativeStorage.migrateLegacy(TOKEN_KEY, 'slipstream_token')
  const storedToken = await nativeStorage.get(TOKEN_KEY)

  // -- Server origin resolution --
  // A stored override (set by the token gate, or the mobile Server settings
  // tab) wins; otherwise default to the SPA's own origin — the historical
  // behavior, and the common case when the server serves its own SPA.
  const storedServer = await nativeStorage.get(DAEMON_URL_KEY)
  const serverOrigin = storedServer || location.origin
  const wsUrl = rpcWsUrl(serverOrigin)

  if (!storedToken) {
    // No token at all — show gate immediately
    await showTokenGate(serverOrigin, '')
    return
  }

  // We have a token — try to connect.
  await connectWithToken(wsUrl, storedToken, createWsApi, serverOrigin)
}

/**
 * Ask the server (via the unauthenticated /healthz endpoint) whether it wants
 * browser clients to use the one-time WS ticket flow (docs/SECURITY.md §3) —
 * only reverse-proxy-fronted deployments opt in (SLIPSTREAM_WS_TICKETS=1).
 * Electron never calls this (bootElectron always uses ?token=). Any failure
 * (offline, old server without the field) defaults to false — falling back
 * to the legacy ?token= URL rather than blocking boot.
 */
async function wsTicketsEnabled(serverOrigin: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/healthz', serverOrigin))
    if (!res.ok) return false
    const body = (await res.json()) as { wsTickets?: boolean }
    return body.wsTickets === true
  } catch {
    return false
  }
}

async function connectWithToken(
  wsUrl: string,
  token: string,
  createWsApi: typeof import('./lib/wsApi.js').createWsApi,
  serverOrigin: string,
): Promise<void> {
  const useTickets = await wsTicketsEnabled(serverOrigin)

  return new Promise<void>((resolve) => {
    let authFailed = false

    const api = createWsApi({
      url: wsUrl,
      token,
      ticketUrl: useTickets ? new URL('/rpc-ticket', serverOrigin).toString() : undefined,
      onAuthError: async () => {
        if (authFailed) return
        authFailed = true
        // This instance is being replaced by the gate's retry — tear it down so its
        // visibilitychange/online/pageshow listeners and heartbeat don't leak.
        api.destroy()
        const { nativeStorage, TOKEN_KEY } = await import('./lib/nativeStorage.js')
        // Only the token is removed — keep the stored server override (if
        // any) so the gate comes back prefilled with the same server.
        await nativeStorage.remove(TOKEN_KEY, 'slipstream_token')
        await showTokenGate(serverOrigin, 'Token rejected. Please enter a valid token.')
        resolve()
      },
    })

    // Assign before any import of App/ipc.ts
    ;(window as unknown as { slipstream?: typeof api }).slipstream = api
    // Mark as web mode so components can distinguish from Electron
    ;(window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb = true
    // Web mode only, and only after window.slipstream is assigned (see above).
    registerServiceWorker()

    // Mount the app — ipc.ts will see window.slipstream = truthy
    mountApp(() => authFailed).then(() => {
      if (authFailed) return // onAuthError already swapped in the gate
      resolve()
    })
  })
}

async function showTokenGate(serverOrigin: string, errorMsg: string): Promise<void> {
  const { default: TokenGate } = await import('./lib/components/TokenGate.svelte')
  clearMount()

  return new Promise<void>((resolve) => {
    // Mount the gate into the app target
    const gate = new TokenGate({
      target,
      props: {
        error: errorMsg,
        server: serverOrigin,
        onSubmit: async (server: string, token: string) => {
          const { nativeStorage, TOKEN_KEY, DAEMON_URL_KEY } =
            await import('./lib/nativeStorage.js')
          await nativeStorage.set(TOKEN_KEY, token)

          // Persist the server choice: no override needed when it matches
          // the SPA's own origin (the historical default) — anything else
          // is stored so subsequent boots (and the gate, on re-prompt) pick
          // it up.
          if (server === location.origin) {
            await nativeStorage.remove(DAEMON_URL_KEY)
          } else {
            await nativeStorage.set(DAEMON_URL_KEY, server)
          }

          // Native shell special case: the Capacitor WebView must reload the
          // SPA itself from the new daemon — same pattern as
          // SettingsServer.svelte. Restart re-enters boot with the new
          // stored server origin.
          if (nativeStorage.isAvailable() && server !== location.origin) {
            await nativeStorage.restart()
            return
          }

          const { createWsApi } = await import('./lib/wsApi.js')
          const { rpcWsUrl } = await import('./lib/serverUrl.js')
          await connectWithToken(rpcWsUrl(server), token, createWsApi, server)
          resolve()
        },
      },
    })
    mounted = gate
  })
}

// ── PWA / Service Worker ──────────────────────────────────────────────────────

let swRegistered = false

/**
 * Register the service worker for PWA installability. Web mode only — called
 * AFTER window.slipstream / __slipstreamWeb are assigned so it never races the
 * bootstrap ordering that ipc.ts depends on. Idempotent.
 */
function registerServiceWorker(): void {
  if (swRegistered) return
  if (!('serviceWorker' in navigator)) return
  swRegistered = true
  // Defer to `load` so SW registration never competes with initial app boot.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[slipstream] service worker registration failed', err)
    })
  })
}

// ── PWA Install prompt capture ────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  ;(
    window as unknown as { __deferredInstallPrompt?: BeforeInstallPromptEvent }
  ).__deferredInstallPrompt = e as BeforeInstallPromptEvent
  window.dispatchEvent(new Event('slipstream:installable'))
})
window.addEventListener('appinstalled', () => {
  ;(
    window as unknown as { __deferredInstallPrompt?: BeforeInstallPromptEvent | null }
  ).__deferredInstallPrompt = null
  window.dispatchEvent(new Event('slipstream:installed'))
})

// ── Entry point ───────────────────────────────────────────────────────────────

async function bootElectron(daemon: { url: string; token: string }): Promise<void> {
  const { createWsApi } = await import('./lib/wsApi.js')
  const api = createWsApi({ url: daemon.url, token: daemon.token })
  // Assign before any import of App/ipc.ts so hasBackend evaluates true
  ;(window as unknown as { slipstream?: typeof api }).slipstream = api
  // Electron has native picker — not web mode
  ;(window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb = false
  // Do NOT register service worker (web/PWA only)
  await mountApp()
}

const daemon = (window as unknown as { __slipstreamDaemon?: { url: string; token: string } | null })
  .__slipstreamDaemon
if (daemon) {
  bootElectron(daemon)
} else if (typeof window !== 'undefined' && window.slipstream) {
  // Legacy safety net
  mountApp()
} else {
  bootWeb()
}
