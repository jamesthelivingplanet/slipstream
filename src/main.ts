import './app.css'
import '@xterm/xterm/css/xterm.css'

/**
 * Boot sequence.
 *
 * Electron: window.slipstream is already set by the preload. We just mount App.
 *
 * Web/browser: window.slipstream is absent. We must:
 *   1. Determine the WS URL + token.
 *   2. If no token → show TokenGate; wait for user to supply one.
 *   3. Create the WS-backed SlipstreamApi and assign window.slipstream BEFORE
 *      importing App (and therefore ipc.ts), so `hasBackend` evaluates true.
 *
 * The dynamic import() approach guarantees that ipc.ts runs its module-level
 * `hasBackend = !!window.slipstream` AFTER we set window.slipstream.
 */

const target = document.getElementById('app')!

async function mountApp() {
  const { default: App } = await import('./App.svelte')
  new App({ target })
}

async function bootWeb() {
  const { createWsApi } = await import('./lib/wsApi.js')

  const wsUrl =
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`

  // -- Token resolution --
  // Priority: ?token= query param > localStorage
  const params = new URLSearchParams(location.search)
  const paramToken = params.get('token')
  if (paramToken) {
    localStorage.setItem('slipstream_token', paramToken)
    // Strip the token from the URL bar (cosmetic + security)
    params.delete('token')
    const clean = params.toString()
    const newUrl = location.pathname + (clean ? `?${clean}` : '') + location.hash
    history.replaceState(null, '', newUrl)
  }

  const storedToken = localStorage.getItem('slipstream_token')

  if (!storedToken) {
    // No token at all — show gate immediately
    await showTokenGate(wsUrl, '')
    return
  }

  // We have a token — try to connect.
  await connectWithToken(wsUrl, storedToken, createWsApi)
}

async function connectWithToken(
  wsUrl: string,
  token: string,
  createWsApi: typeof import('./lib/wsApi.js').createWsApi,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let authFailed = false

    const api = createWsApi({
      url: wsUrl,
      token,
      onAuthError: async () => {
        if (authFailed) return
        authFailed = true
        localStorage.removeItem('slipstream_token')
        await showTokenGate(wsUrl, 'Token rejected. Please enter a valid token.')
        resolve()
      },
    })

    // Assign before any import of App/ipc.ts
    ;(window as Window & { slipstream?: typeof api }).slipstream = api
    // Mark as web mode so components can distinguish from Electron
    ;(window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb = true
    // Web mode only, and only after window.slipstream is assigned (see above).
    registerServiceWorker()

    // Mount the app — ipc.ts will see window.slipstream = truthy
    mountApp().then(resolve)
  })
}

async function showTokenGate(wsUrl: string, errorMsg: string): Promise<void> {
  const { default: TokenGate } = await import('./lib/components/TokenGate.svelte')

  return new Promise<void>((resolve) => {
    // Mount the gate into the app target
    const gate = new TokenGate({
      target,
      props: {
        error: errorMsg,
        onSubmit: async (token: string) => {
          gate.$destroy()
          localStorage.setItem('slipstream_token', token)
          const { createWsApi } = await import('./lib/wsApi.js')
          await connectWithToken(wsUrl, token, createWsApi)
          resolve()
        },
      },
    })
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
  ;(window as unknown as { __deferredInstallPrompt?: BeforeInstallPromptEvent }).__deferredInstallPrompt = e as BeforeInstallPromptEvent
  window.dispatchEvent(new Event('slipstream:installable'))
})
window.addEventListener('appinstalled', () => {
  ;(window as unknown as { __deferredInstallPrompt?: BeforeInstallPromptEvent | null }).__deferredInstallPrompt = null
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

const daemon = (window as unknown as { __slipstreamDaemon?: { url: string; token: string } | null }).__slipstreamDaemon
if (daemon) {
  bootElectron(daemon)
} else if (typeof window !== 'undefined' && window.slipstream) {
  // Legacy safety net
  mountApp()
} else {
  bootWeb()
}
