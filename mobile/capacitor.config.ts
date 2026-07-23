import type { CapacitorConfig } from '@capacitor/cli'

// Kiosk-mode shell: the WebView loads the daemon-served SPA directly over
// the tailnet. `server.url` below is the build-time baked default; at
// runtime, MainActivity.java overrides it from a Preferences-stored
// 'slipstream.daemonUrl' value if one is present (see Settings > Server in
// the SPA), falling back to this baked URL otherwise. `www/index.html` is
// only ever shown as the entry for a future build with NO baked server.url
// — it's a self-contained ServerGate for setting that preference from
// scratch. Auth is handled entirely by the SPA's own TokenGate screen, so
// this app has no separate token/credential handling of its own.
// `server.errorPath` points at `www/offline.html`, Nulliel's "can't reach the
// daemon" page — Capacitor's BridgeWebViewClient loads it in place of
// Chromium's default error page whenever the main-frame load of `server.url`
// fails, with a one-tap retry and the same daemon-URL-editing form as the
// ServerGate.
const config: CapacitorConfig = {
  appId: 'app.slipstream.mobile',
  appName: 'Slipstream',
  webDir: 'www',
  server: {
    url: 'https://omarchy.taile11bed.ts.net',
    errorPath: 'offline.html',
  },
}

export default config
