import './app.css'
import '@xterm/xterm/css/xterm.css'

/**
 * Boot sequence.
 *
 * Electron: window.flotilla is already set by the preload. We just mount App.
 *
 * Web/browser: window.flotilla is absent. We must:
 *   1. Determine the WS URL + token.
 *   2. If no token → show TokenGate; wait for user to supply one.
 *   3. Create the WS-backed FlotillaApi and assign window.flotilla BEFORE
 *      importing App (and therefore ipc.ts), so `hasBackend` evaluates true.
 *
 * The dynamic import() approach guarantees that ipc.ts runs its module-level
 * `hasBackend = !!window.flotilla` AFTER we set window.flotilla.
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
    localStorage.setItem('flotilla_token', paramToken)
    // Strip the token from the URL bar (cosmetic + security)
    params.delete('token')
    const clean = params.toString()
    const newUrl = location.pathname + (clean ? `?${clean}` : '') + location.hash
    history.replaceState(null, '', newUrl)
  }

  const storedToken = localStorage.getItem('flotilla_token')

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
        localStorage.removeItem('flotilla_token')
        await showTokenGate(wsUrl, 'Token rejected. Please enter a valid token.')
        resolve()
      },
    })

    // Assign before any import of App/ipc.ts
    ;(window as Window & { flotilla?: typeof api }).flotilla = api
    // Mark as web mode so components can distinguish from Electron
    ;(window as unknown as { __flotillaWeb?: boolean }).__flotillaWeb = true

    // Mount the app — ipc.ts will see window.flotilla = truthy
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
          localStorage.setItem('flotilla_token', token)
          const { createWsApi } = await import('./lib/wsApi.js')
          await connectWithToken(wsUrl, token, createWsApi)
          resolve()
        },
      },
    })
  })
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && window.flotilla) {
  // Electron — preload already set window.flotilla; boot straight to App.
  mountApp()
} else {
  bootWeb()
}
