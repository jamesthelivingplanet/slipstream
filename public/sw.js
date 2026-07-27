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

// ── FLO-150: reply credentials ──────────────────────────────────────────────
//
// The SW can't call the page's in-memory `writeSession` (no live WebSocket, no
// access to window.slipstream). To answer a quick Approve/Deny from the
// notification without opening the app, it POSTs to the daemon's existing
// /inline-reply endpoint (added for FLO-151's native RemoteInput path) — which
// needs the bearer token + server origin the page already holds. The page
// pushes both here (postMessage → IndexedDB) right after the SW is ready, so a
// background notificationclick can reach the daemon even with the app closed.
//
// Security: this mirrors what the page already keeps in localStorage (web) /
// native secure storage (mobile) — storing the bearer token in the SW's
// same-origin IndexedDB does not lower the posture (a same-origin reader can
// already read localStorage). creds are cleared by the page on logout / token
// rotation (main.ts).
const DB_NAME = 'slipstream-sw'
const DB_VERSION = 1
const CREDS_STORE = 'kv'
const CREDS_KEY = 'replyCreds'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CREDS_STORE)) db.createObjectStore(CREDS_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function putCreds(creds) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CREDS_STORE, 'readwrite')
    tx.objectStore(CREDS_STORE).put(creds, CREDS_KEY)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function getCreds() {
  const db = await openDb()
  const creds = await new Promise((resolve, reject) => {
    const tx = db.transaction(CREDS_STORE, 'readonly')
    const req = tx.objectStore(CREDS_STORE).get(CREDS_KEY)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return creds || null
}

async function clearCreds() {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CREDS_STORE, 'readwrite')
    tx.objectStore(CREDS_STORE).delete(CREDS_KEY)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

self.addEventListener('message', (event) => {
  const data = event.data
  // The page stashes the daemon origin + bearer token so a background
  // notificationclick can POST /inline-reply. Empty values => logout / token
  // rotation: clear the stash so a stale token can't be replayed.
  if (data && data.type === 'set-reply-creds') {
    if (data.url && data.token) {
      event.waitUntil(putCreds({ url: data.url, token: data.token }))
    } else {
      event.waitUntil(clearCreds())
    }
  }
})

// ── Push ────────────────────────────────────────────────────────────────────
//
// FLO-150: action buttons on the "needs input" notification. Android/Chrome
// render the `actions` array; Safari/iOS ignore it entirely (the Notifications
// API `actions` field is unsupported there as of 2024 — verify before promising
// parity). On browsers that ignore it, tapping the notification body still
// deep-links via notificationclick below, so those users degrade to the prior
// single-tap behavior rather than losing the notification.
//
// Approval-shaped asks (status==='needs' && reason==='approval') get quick
// Approve/Deny buttons, which POST a canned 'y'/'n' reply; other needs asks
// get a plain View button (nothing sensible to quick-reply). The `reason`
// field is carried in the push payload by pushService.ts.
function actionsFor(data) {
  if (data.status !== 'needs') return undefined
  if (data.reason === 'approval') {
    return [
      { action: 'approve', title: 'Approve' },
      { action: 'deny', title: 'Deny' },
    ]
  }
  return [{ action: 'view', title: 'View' }]
}

self.addEventListener('push', (event) => {
  if (!event.data) return
  const data = event.data.json()
  const options = {
    body: data.body,
    tag: data.tid,
    data: { tid: data.tid, sessionId: data.sessionId, status: data.status, reason: data.reason },
    // Nulliel is the notification's sender (TASK-F0TYG) — the mascot's own
    // icon, not the app's generic brand icon. badge stays the brand icon:
    // it's the monochrome status-bar glyph, rendered too small/silhouetted
    // for Nulliel's detail to read.
    icon: '/icons/nulliel-192.png',
    badge: '/icons/icon-192.png',
  }
  const actions = actionsFor(data)
  if (actions) options.actions = actions
  event.waitUntil(self.registration.showNotification(data.title, options))
})

// ── notificationclick ───────────────────────────────────────────────────────
//
// FLO-150: an action button was tapped. Approve/Deny POST a canned yes/no
// through /inline-reply (same endpoint + bearer auth + ownership check the
// native RemoteInput path uses, FLO-151); 'view' or a plain body tap deep-links
// as before. On any reply failure (no stashed creds, auth rejected, network),
// fall back to opening the session so the tap is never a silent no-op — the
// user can always answer manually.
async function focusOrOpenAgent(sessionId) {
  const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (windowClients.length > 0) {
    windowClients[0].focus()
    windowClients[0].postMessage({ type: 'open-agent', sessionId })
    return
  }
  return clients.openWindow('/?agent=' + encodeURIComponent(sessionId))
}

async function replyToSession(sessionId, data) {
  const creds = await getCreds()
  if (!creds) {
    // No stashed credentials (page never ran, or logged out) — open the
    // session so the user can answer manually.
    return focusOrOpenAgent(sessionId)
  }
  try {
    const res = await fetch(new URL('/inline-reply', creds.url).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + creds.token,
      },
      body: JSON.stringify({ sessionId, data }),
    })
    // 204 = reply accepted; anything else (401 stale token, 404 ownership,
    // 4xx/5xx) falls back to opening the session rather than dropping the tap.
    if (!res.ok && res.status !== 204) {
      await focusOrOpenAgent(sessionId)
    }
  } catch {
    // Network/abort — best-effort safety net.
    await focusOrOpenAgent(sessionId)
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data.sessionId

  // Canned yes/no matches the common CLI convention (Claude Code permission
  // prompts, generic y/n). Agents using a different scheme still work — the
  // user falls back to opening the session. The newline is appended by the
  // /inline-reply handler so the reply submits as one line.
  if (event.action === 'approve') {
    event.waitUntil(replyToSession(sessionId, 'y'))
    return
  }
  if (event.action === 'deny') {
    event.waitUntil(replyToSession(sessionId, 'n'))
    return
  }

  // 'view' action or a plain body tap (event.action === '') — deep-link.
  event.waitUntil(focusOrOpenAgent(sessionId))
})
