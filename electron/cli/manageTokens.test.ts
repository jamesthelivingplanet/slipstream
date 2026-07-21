import { describe, it, expect } from 'vitest'
import { runManageTokens } from './manageTokens.js'
import type { IDeviceTokenStore, DeviceTokenDTO } from '../services/deviceTokenStore.js'

function makeFakeStore(): IDeviceTokenStore {
  const rows = new Map<string, DeviceTokenDTO>()
  const tokens = new Map<string, string>()
  let n = 0
  return {
    issue(ownerId, label) {
      const id = `dt${++n}`
      const token = `dt-token-${id}`
      const dto: DeviceTokenDTO = { id, ownerId, label, createdAt: 0, revokedAt: null }
      rows.set(id, dto)
      tokens.set(id, token)
      return { token, dto }
    },
    list() {
      return Array.from(rows.values())
    },
    get(id) {
      return rows.get(id)
    },
    revoke(id) {
      const row = rows.get(id)
      if (row && row.revokedAt === null) row.revokedAt = 1
    },
    resolveToken(token) {
      for (const [id, t] of tokens) {
        if (t === token) {
          const row = rows.get(id)
          return row && row.revokedAt === null ? { id: row.ownerId } : undefined
        }
      }
      return undefined
    },
  }
}

function run(argv: string[], store: IDeviceTokenStore): { code: number; output: string[] } {
  const output: string[] = []
  const code = runManageTokens(argv, { store, log: (msg) => output.push(msg) })
  return { code, output }
}

describe('runManageTokens', () => {
  it('issues a token and prints it exactly once, alongside its metadata', () => {
    const store = makeFakeStore()
    const { code, output } = run(['issue', 'alice', 'alice phone'], store)
    expect(code).toBe(0)
    const printed = JSON.parse(output[0]) as DeviceTokenDTO & { token: string }
    expect(printed.ownerId).toBe('alice')
    expect(printed.label).toBe('alice phone')
    expect(printed.token).toMatch(/^dt-token-/)
    expect(store.resolveToken(printed.token)).toEqual({ id: 'alice' })
  })

  it('rejects issue without both an ownerId and a label', () => {
    const store = makeFakeStore()
    expect(run(['issue', 'alice'], store).code).toBe(1)
    expect(run(['issue'], store).code).toBe(1)
  })

  it('lists every issued token', () => {
    const store = makeFakeStore()
    store.issue('alice', 'phone')
    store.issue('bob', 'laptop')
    const { code, output } = run(['list'], store)
    expect(code).toBe(0)
    const printed = JSON.parse(output[0]) as DeviceTokenDTO[]
    expect(printed.map((d) => d.ownerId).sort()).toEqual(['alice', 'bob'])
  })

  it('revokes a token by id, isolated from other tokens', () => {
    const store = makeFakeStore()
    const alice = store.issue('alice', 'phone')
    const bob = store.issue('bob', 'laptop')

    const { code } = run(['revoke', alice.dto.id], store)
    expect(code).toBe(0)
    expect(store.resolveToken(alice.token)).toBeUndefined()
    expect(store.resolveToken(bob.token)).toEqual({ id: 'bob' })
  })

  it('rejects revoke without an id', () => {
    const store = makeFakeStore()
    expect(run(['revoke'], store).code).toBe(1)
  })

  it('prints usage and returns 1 for an unknown command', () => {
    const store = makeFakeStore()
    const { code, output } = run(['bogus'], store)
    expect(code).toBe(1)
    expect(output[0]).toMatch(/^Usage:/)
  })
})
