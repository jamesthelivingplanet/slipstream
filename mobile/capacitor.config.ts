import type { CapacitorConfig } from '@capacitor/cli'

// Kiosk-mode shell: the WebView loads the daemon-served SPA directly over
// the tailnet. There is no bundled web app beyond the `www/index.html`
// fallback shown if the remote load fails (offline, VPN down, etc). Auth is
// handled entirely by the SPA's own TokenGate screen, so this app has no
// token/credential handling of its own.
const config: CapacitorConfig = {
  appId: 'app.slipstream.mobile',
  appName: 'Slipstream',
  webDir: 'www',
  server: {
    url: 'https://omarchy.taile11bed.ts.net',
  },
}

export default config
