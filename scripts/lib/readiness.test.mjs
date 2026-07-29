import { describe, expect, it } from 'vitest'
import { evaluateReadiness } from './readiness.mjs'

/** A fully-passing facts object; pass overrides to twist one thing at a time. */
function baseFacts(overrides = {}) {
  return {
    env: {
      SLIPSTREAM_TOKEN: 'a-real-token',
      SLIPSTREAM_SERVE: 'tailscale',
      SLIPSTREAM_WS_TICKETS: '1',
      SLIPSTREAM_SECRET: 'a-passphrase',
      SLIPSTREAM_SANDBOX: 'bwrap',
      SLIPSTREAM_ALLOWED_ORIGINS: 'https://host.tailnet.ts.net',
    },
    bwrapOnPath: true,
    dataDirExists: true,
    dataDirMode: 0o700,
    daemonJsonExists: true,
    daemonJsonMode: 0o600,
    secretKeyExists: false,
    secretSaltExists: true,
    version: '1.2.3',
    sandboxShadowed: false,
    ...overrides,
  }
}

function checkById(result, id) {
  return result.checks.find((c) => c.id === id)
}

describe('evaluateReadiness — overall shape', () => {
  it('every check has a non-empty detail and doc', () => {
    const result = evaluateReadiness(baseFacts())
    for (const check of result.checks) {
      expect(check.detail).toBeTruthy()
      expect(check.doc).toBeTruthy()
    }
  })

  it('ok is true when the only non-passes are warns/infos', () => {
    const result = evaluateReadiness(
      baseFacts({
        env: { SLIPSTREAM_TOKEN: 'x', SLIPSTREAM_SERVE: 'none' },
        dataDirExists: false,
        daemonJsonExists: false,
        secretKeyExists: false,
      }),
    )
    expect(result.checks.some((c) => c.status === 'fail')).toBe(false)
    expect(result.ok).toBe(true)
  })

  it('posture is tailscale/local/unknown derived from SLIPSTREAM_SERVE', () => {
    expect(evaluateReadiness(baseFacts({ env: { SLIPSTREAM_SERVE: 'tailscale' } })).posture).toBe(
      'tailscale',
    )
    expect(evaluateReadiness(baseFacts({ env: { SLIPSTREAM_SERVE: 'none' } })).posture).toBe(
      'local',
    )
    expect(evaluateReadiness(baseFacts({ env: {} })).posture).toBe('local')
    expect(evaluateReadiness(baseFacts({ env: { SLIPSTREAM_SERVE: 'weird' } })).posture).toBe(
      'unknown',
    )
  })
})

describe('auth-token', () => {
  it('missing SLIPSTREAM_TOKEN is a hard fail and makes ok false', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_TOKEN: '' } }),
    )
    expect(checkById(result, 'auth-token').status).toBe('fail')
    expect(result.ok).toBe(false)
  })

  it('present SLIPSTREAM_TOKEN passes', () => {
    const result = evaluateReadiness(baseFacts())
    expect(checkById(result, 'auth-token').status).toBe('pass')
  })
})

describe('ws-tickets', () => {
  it('tailscale posture is info regardless of the ticket flag', () => {
    const result = evaluateReadiness(
      baseFacts({
        env: {
          ...baseFacts().env,
          SLIPSTREAM_SERVE: 'tailscale',
          SLIPSTREAM_WS_TICKETS: undefined,
        },
      }),
    )
    expect(checkById(result, 'ws-tickets').status).toBe('info')
  })

  it('local posture without the flag warns', () => {
    const result = evaluateReadiness(
      baseFacts({
        env: { ...baseFacts().env, SLIPSTREAM_SERVE: 'none', SLIPSTREAM_WS_TICKETS: undefined },
      }),
    )
    expect(checkById(result, 'ws-tickets').status).toBe('warn')
  })

  it('local posture with SLIPSTREAM_WS_TICKETS=1 passes', () => {
    const result = evaluateReadiness(
      baseFacts({
        env: { ...baseFacts().env, SLIPSTREAM_SERVE: 'none', SLIPSTREAM_WS_TICKETS: '1' },
      }),
    )
    expect(checkById(result, 'ws-tickets').status).toBe('pass')
  })
})

describe('secrets-at-rest', () => {
  it('SLIPSTREAM_SECRET set passes', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_SECRET: 'pw' }, secretKeyExists: false }),
    )
    expect(checkById(result, 'secrets-at-rest').status).toBe('pass')
  })

  it('no SLIPSTREAM_SECRET but secretKeyExists passes', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_SECRET: '' }, secretKeyExists: true }),
    )
    expect(checkById(result, 'secrets-at-rest').status).toBe('pass')
  })

  it('neither SLIPSTREAM_SECRET nor secret.key warns', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_SECRET: '' }, secretKeyExists: false }),
    )
    expect(checkById(result, 'secrets-at-rest').status).toBe('warn')
  })
})

describe('agent-sandbox', () => {
  it('bwrap requested but missing from PATH is a hard FAIL (fails open)', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_SANDBOX: 'bwrap' }, bwrapOnPath: false }),
    )
    const check = checkById(result, 'agent-sandbox')
    expect(check.status).toBe('fail')
    expect(check.detail).toMatch(/UNSANDBOXED/)
    expect(result.ok).toBe(false)
  })

  it('bwrap requested and present passes', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_SANDBOX: 'bwrap' }, bwrapOnPath: true }),
    )
    expect(checkById(result, 'agent-sandbox').status).toBe('pass')
  })

  it('sandbox unset warns', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_SANDBOX: undefined }, bwrapOnPath: false }),
    )
    expect(checkById(result, 'agent-sandbox').status).toBe('warn')
  })
})

describe('origin-allowlist', () => {
  it('set passes', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_ALLOWED_ORIGINS: 'https://x' } }),
    )
    expect(checkById(result, 'origin-allowlist').status).toBe('pass')
  })

  it('unset warns (never fails)', () => {
    const result = evaluateReadiness(
      baseFacts({ env: { ...baseFacts().env, SLIPSTREAM_ALLOWED_ORIGINS: '' } }),
    )
    expect(checkById(result, 'origin-allowlist').status).toBe('warn')
  })
})

describe('data-dir-perms', () => {
  it('absent is info', () => {
    const result = evaluateReadiness(baseFacts({ dataDirExists: false, dataDirMode: undefined }))
    expect(checkById(result, 'data-dir-perms').status).toBe('info')
  })

  it('0700 passes', () => {
    const result = evaluateReadiness(baseFacts({ dataDirExists: true, dataDirMode: 0o700 }))
    expect(checkById(result, 'data-dir-perms').status).toBe('pass')
  })

  it('any other mode fails', () => {
    const result = evaluateReadiness(baseFacts({ dataDirExists: true, dataDirMode: 0o755 }))
    expect(checkById(result, 'data-dir-perms').status).toBe('fail')
  })
})

describe('daemon-json-perms', () => {
  it('absent is info', () => {
    const result = evaluateReadiness(
      baseFacts({ daemonJsonExists: false, daemonJsonMode: undefined }),
    )
    expect(checkById(result, 'daemon-json-perms').status).toBe('info')
  })

  it('0600 passes', () => {
    const result = evaluateReadiness(baseFacts({ daemonJsonExists: true, daemonJsonMode: 0o600 }))
    expect(checkById(result, 'daemon-json-perms').status).toBe('pass')
  })

  it('any other mode fails', () => {
    const result = evaluateReadiness(baseFacts({ daemonJsonExists: true, daemonJsonMode: 0o644 }))
    expect(checkById(result, 'daemon-json-perms').status).toBe('fail')
  })
})

describe('version-stamp', () => {
  it('missing version fails', () => {
    const result = evaluateReadiness(baseFacts({ version: undefined }))
    expect(checkById(result, 'version-stamp').status).toBe('fail')
  })

  it('0.0.0 fails', () => {
    const result = evaluateReadiness(baseFacts({ version: '0.0.0' }))
    expect(checkById(result, 'version-stamp').status).toBe('fail')
  })

  it('a real version passes', () => {
    const result = evaluateReadiness(baseFacts({ version: '0.8.1' }))
    expect(checkById(result, 'version-stamp').status).toBe('pass')
  })
})

describe('multi-user', () => {
  it('is always info', () => {
    const result = evaluateReadiness(baseFacts())
    expect(checkById(result, 'multi-user').status).toBe('info')
  })
})

describe('sandboxShadowed (FLO-142 follow-up: bwrap tmpfs shadow)', () => {
  const SHADOWED_IDS = [
    'auth-token',
    'ws-tickets',
    'secrets-at-rest',
    'agent-sandbox',
    'origin-allowlist',
    'data-dir-perms',
    'daemon-json-perms',
  ]

  it('never yields a fail and ok stays true even with facts that would otherwise FAIL', () => {
    const result = evaluateReadiness(
      baseFacts({
        sandboxShadowed: true,
        env: { ...baseFacts().env, SLIPSTREAM_TOKEN: '' }, // would be a hard fail unshadowed
        dataDirExists: true,
        dataDirMode: 0o755, // would be a hard fail unshadowed
      }),
    )
    expect(result.checks.some((c) => c.status === 'fail')).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.shadowed).toBe(true)
  })

  it('adds observation-scope as the first check, warn status', () => {
    const result = evaluateReadiness(baseFacts({ sandboxShadowed: true }))
    expect(result.checks[0].id).toBe('observation-scope')
    expect(result.checks[0].status).toBe('warn')
  })

  it('observation-scope is absent when not shadowed', () => {
    const result = evaluateReadiness(baseFacts({ sandboxShadowed: false }))
    expect(checkById(result, 'observation-scope')).toBeUndefined()
  })

  it('shadowed sets shadowed:false when not sandboxShadowed', () => {
    const result = evaluateReadiness(baseFacts({ sandboxShadowed: false }))
    expect(result.shadowed).toBe(false)
  })

  it('the seven affected checks become info when shadowed', () => {
    const result = evaluateReadiness(baseFacts({ sandboxShadowed: true }))
    for (const id of SHADOWED_IDS) {
      expect(checkById(result, id).status).toBe('info')
    }
  })

  it('version-stamp and multi-user keep their normal status when shadowed', () => {
    const result = evaluateReadiness(baseFacts({ sandboxShadowed: true, version: '1.2.3' }))
    expect(checkById(result, 'version-stamp').status).toBe('pass')
    expect(checkById(result, 'multi-user').status).toBe('info')

    const failing = evaluateReadiness(baseFacts({ sandboxShadowed: true, version: '0.0.0' }))
    expect(checkById(failing, 'version-stamp').status).toBe('fail')
  })

  it('non-shadowed results are unchanged for the same facts (regression guard)', () => {
    const result = evaluateReadiness(baseFacts({ sandboxShadowed: false }))
    expect(checkById(result, 'auth-token').status).toBe('pass')
    expect(checkById(result, 'data-dir-perms').status).toBe('pass')
    expect(checkById(result, 'agent-sandbox').status).toBe('pass')
    expect(result.checks.some((c) => c.id === 'observation-scope')).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.shadowed).toBe(false)
  })
})
