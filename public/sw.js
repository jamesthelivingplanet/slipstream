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

self.addEventListener('push', (event) => {
  if (!event.data) return
  const data = event.data.json()
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tid,
      data: { tid: data.tid, sessionId: data.sessionId },
      // Nulliel is the notification's sender (TASK-F0TYG) — the mascot's own
      // icon, not the app's generic brand icon. badge stays the brand icon:
      // it's the monochrome status-bar glyph, rendered too small/silhouetted
      // for Nulliel's detail to read.
      icon: '/icons/nulliel-192.png',
      badge: '/icons/icon-192.png',
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data.sessionId
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      if (windowClients.length > 0) {
        windowClients[0].focus()
        windowClients[0].postMessage({ type: 'open-agent', sessionId })
      } else {
        return clients.openWindow('/?agent=' + encodeURIComponent(sessionId))
      }
    })
  )
})
