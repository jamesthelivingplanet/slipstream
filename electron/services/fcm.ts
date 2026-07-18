/**
 * FCM HTTP v1 transport (TASK-I9S44) — pure, stateless helpers composed by
 * pushService.ts (which owns the access-token cache and the fan-out/prune
 * loop, mirroring how it already composes web-push). No new npm deps: the
 * OAuth2 service-account grant is a hand-rolled RS256 JWT signed with
 * node:crypto, exchanged for a bearer token via a plain fetch — see
 * https://developers.google.com/identity/protocols/oauth2/service-account.
 */
import { createSign } from 'node:crypto'

export interface FcmServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

/** Parse+validate a Firebase service-account JSON blob. Returns null (never
 *  throws) on invalid JSON or missing fields — callers treat that identically
 *  to "not configured" so a malformed credential doesn't blow up every send. */
export function parseServiceAccount(raw: string): FcmServiceAccount | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const { project_id, client_email, private_key } = obj
    if (
      typeof project_id === 'string' &&
      project_id.length > 0 &&
      typeof client_email === 'string' &&
      client_email.length > 0 &&
      typeof private_key === 'string' &&
      private_key.length > 0
    ) {
      return { project_id, client_email, private_key }
    }
    return null
  } catch {
    return null
  }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buf.toString('base64url')
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const JWT_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** Google's JWT-bearer grants max out at 1h; matches the OAuth2 service-account docs. */
const JWT_LIFETIME_SEC = 3600

export interface MintedAccessToken {
  accessToken: string
  /** epoch ms */
  expiresAt: number
}

/** Mint a fresh OAuth2 access token from the service account via the RS256
 *  JWT-bearer grant. Throws on a non-2xx response or malformed body — callers
 *  (pushService) catch and swallow per-send, matching the existing web-push
 *  best-effort error handling. */
export async function mintAccessToken(
  account: FcmServiceAccount,
  opts: { fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<MintedAccessToken> {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const nowSec = Math.floor(now() / 1000)

  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: account.client_email,
    scope: JWT_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: nowSec,
    exp: nowSec + JWT_LIFETIME_SEC,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(account.private_key)
  const jwt = `${signingInput}.${base64url(signature)}`

  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  })
  if (!res.ok) {
    throw new Error(`FCM token mint failed: HTTP ${res.status}`)
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token || typeof body.expires_in !== 'number') {
    throw new Error('FCM token mint: malformed token response')
  }
  return { accessToken: body.access_token, expiresAt: now() + body.expires_in * 1000 }
}

export interface FcmSendResult {
  ok: boolean
  status: number
  /** True on a 404/UNREGISTERED response — the device token should be pruned,
   *  mirroring the web-push 404/410 prune rule. */
  unregistered: boolean
}

/** POST a single notification to one FCM device token via HTTP v1. Never
 *  throws for an HTTP-level failure (returns { ok:false } instead) — only a
 *  network-level fetch rejection propagates, same contract as PushSender.
 *
 *  `notification.data` (TASK-F0TYG) rides alongside the title/body as the
 *  FCM message's top-level `data` block, so a tap on the native notification
 *  can deep-link to the session — FCM v1 requires every `data` value to be a
 *  string, matching Record<string, string> below. Optional: omitted entirely
 *  from the request body when not given, matching the pre-TASK-F0TYG shape.
 *
 *  `notification.image` (TASK-F0TYG follow-up) is a device-reachable HTTPS
 *  URL for the full-color Nulliel picture; FCM v1 puts it at
 *  `message.android.notification.image`, not on the top-level `notification`
 *  block. When absent, `android` stays exactly `{ priority: 'high' }` as
 *  before this change. */
export async function sendFcmMessage(
  account: FcmServiceAccount,
  accessToken: string,
  deviceToken: string,
  notification: { title: string; body: string; data?: Record<string, string>; image?: string },
  opts: { fetchFn?: typeof fetch } = {},
): Promise<FcmSendResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const { data, image, ...notificationFields } = notification
  const res = await fetchFn(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: notificationFields,
          ...(data ? { data } : {}),
          android: { priority: 'high', ...(image ? { notification: { image } } : {}) },
        },
      }),
    },
  )
  if (res.ok) return { ok: true, status: res.status, unregistered: false }

  let unregistered = res.status === 404
  if (!unregistered) {
    try {
      const body = (await res.json()) as { error?: { status?: string } }
      if (body?.error?.status === 'UNREGISTERED' || body?.error?.status === 'NOT_FOUND') {
        unregistered = true
      }
    } catch {
      // non-JSON error body — fall through with unregistered=false
    }
  }
  return { ok: false, status: res.status, unregistered }
}
