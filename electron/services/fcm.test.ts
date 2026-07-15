import { describe, it, expect, vi, beforeAll } from 'vitest'
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { parseServiceAccount, mintAccessToken, sendFcmMessage } from './fcm.js'
import type { FcmServiceAccount } from './fcm.js'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let account: FcmServiceAccount
let publicKeyPem: string

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  publicKeyPem = publicKey
  account = {
    project_id: 'test-project',
    client_email: 'svc@test-project.iam.gserviceaccount.com',
    private_key: privateKey,
  }
})

describe('parseServiceAccount', () => {
  it('parses a well-formed service-account JSON blob', () => {
    const raw = JSON.stringify({
      project_id: 'p1',
      client_email: 'a@p1.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      // real service-account JSON has more fields; extras must be ignored
      type: 'service_account',
    })
    expect(parseServiceAccount(raw)).toEqual({
      project_id: 'p1',
      client_email: 'a@p1.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    })
  })

  it('returns null for invalid JSON', () => {
    expect(parseServiceAccount('not json')).toBeNull()
  })

  it('returns null when a required field is missing', () => {
    expect(parseServiceAccount(JSON.stringify({ project_id: 'p1' }))).toBeNull()
  })

  it('returns null when a required field is the wrong type', () => {
    expect(
      parseServiceAccount(
        JSON.stringify({ project_id: 1, client_email: 'a@b.com', private_key: 'x' }),
      ),
    ).toBeNull()
  })

  it('returns null for an empty string field', () => {
    expect(
      parseServiceAccount(
        JSON.stringify({ project_id: '', client_email: 'a@b.com', private_key: 'x' }),
      ),
    ).toBeNull()
  })
})

describe('mintAccessToken', () => {
  it('signs a real RS256 JWT verifiable by the matching public key', async () => {
    let capturedAssertion: string | undefined
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const params = new URLSearchParams(init!.body as string)
      capturedAssertion = params.get('assertion') ?? undefined
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
      return jsonResponse({ access_token: 'minted-token-abc', expires_in: 3600 })
    })

    const result = await mintAccessToken(account, {
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    })

    expect(result.accessToken).toBe('minted-token-abc')
    expect(result.expiresAt).toBe(1_700_000_000_000 + 3600 * 1000)
    expect(fetchFn).toHaveBeenCalledOnce()

    // Verify the JWT was actually signed with the service account's private key.
    expect(capturedAssertion).toBeTruthy()
    const [headerB64, claimsB64, sigB64] = capturedAssertion!.split('.')
    const signingInput = `${headerB64}.${claimsB64}`
    const signature = Buffer.from(sigB64, 'base64url')
    const valid = cryptoVerify('RSA-SHA256', Buffer.from(signingInput), publicKeyPem, signature)
    expect(valid).toBe(true)

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'))
    expect(claims).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 3600,
    })
  })

  it('throws when the token endpoint responds non-2xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 401))
    await expect(
      mintAccessToken(account, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 401/)
  })

  it('throws when the response body is malformed', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ nope: true }))
    await expect(
      mintAccessToken(account, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/malformed token response/)
  })
})

describe('sendFcmMessage', () => {
  it('posts to the v1 messages:send endpoint with the expected shape', async () => {
    let capturedUrl: string | undefined
    let capturedBody: unknown
    let capturedAuth: string | undefined
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedBody = JSON.parse(init!.body as string)
      capturedAuth = (init!.headers as Record<string, string>).authorization
      return jsonResponse({ name: 'projects/test-project/messages/123' })
    })

    const result = await sendFcmMessage(
      account,
      'access-tok',
      'device-tok-1',
      { title: 'Hi', body: 'there' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    )

    expect(result).toEqual({ ok: true, status: 200, unregistered: false })
    expect(capturedUrl).toBe('https://fcm.googleapis.com/v1/projects/test-project/messages:send')
    expect(capturedAuth).toBe('Bearer access-tok')
    expect(capturedBody).toEqual({
      message: {
        token: 'device-tok-1',
        notification: { title: 'Hi', body: 'there' },
        android: { priority: 'high' },
      },
    })
  })

  it('flags unregistered on a 404 response', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 404, status: 'NOT_FOUND' } }, false, 404),
    )
    const result = await sendFcmMessage(
      account,
      'tok',
      'dead-token',
      { title: 't', body: 'b' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(result).toEqual({ ok: false, status: 404, unregistered: true })
  })

  it('flags unregistered when the body carries error.status UNREGISTERED even off a non-404 status', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 400, status: 'UNREGISTERED' } }, false, 400),
    )
    const result = await sendFcmMessage(
      account,
      'tok',
      'dead-token',
      { title: 't', body: 'b' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(result.unregistered).toBe(true)
  })

  it('does not flag unregistered for other failures', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 500, status: 'INTERNAL' } }, false, 500),
    )
    const result = await sendFcmMessage(
      account,
      'tok',
      'some-token',
      { title: 't', body: 'b' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(result).toEqual({ ok: false, status: 500, unregistered: false })
  })
})
