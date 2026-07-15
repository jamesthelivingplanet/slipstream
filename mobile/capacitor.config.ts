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
const config: CapacitorConfig = {
  appId: 'app.slipstream.mobile',
  appName: 'Slipstream',
  webDir: 'www',
  server: {
    url: 'https://omarchy.taile11bed.ts.net',
  },
}

export default config
