// Slipstream service worker — minimal, exists to make the web app installable as a PWA.
// App-shell / offline caching is intentionally omitted for v1 (see ticket FLO-29);
// this is the foundation for future background features (e.g. push notifications).
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// A fetch handler is required for the app to be considered installable in some
// browsers. Network-only pass-through for now (no caching).
self.addEventListener('fetch', () => {})
