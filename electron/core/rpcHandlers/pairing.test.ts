import { describe, it, expect, vi } from 'vitest'
import { createPairingHandlers } from './pairing.js'
import { IPC } from '../../shared/contract.js'
import type { IpcDeps } from '../../ipc.js'
import type { RpcContext } from '../rpcContext.js'
import type { DevicePairingStore } from '../../services/devicePairing.js'

function makeCtx(identityId: string): RpcContext {
  return {
    identity: { id: identityId },
    clientId: 'client-1',
    ownedByCaller: () => true,
    ownedSession: () => undefined,
    requireOwnedRepo: async () => {
      throw new Error('not used')
    },
    requireSafeBranch: (b) => b,
    lockState: (id) => ({ sessionId: id, canWrite: true, viewers: 1 }),
    resolveOutcome: async () => null,
  }
}

describe('createPairingHandlers', () => {
  it('createPairingCode mints a code bound to the CALLER identity from RpcContext', async () => {
    const issue = vi.fn().mockReturnValue({ code: 'abc123', expiresAt: 12345 })
    const pairing: DevicePairingStore = {
      issue,
      redeem: vi.fn(),
      dispose: vi.fn(),
    }
    const deps = { pairing } as unknown as IpcDeps
    const ctx = makeCtx('alice')

    const handlers = createPairingHandlers(deps, ctx)
    const result = await handlers[IPC.createPairingCode]([])

    expect(issue).toHaveBeenCalledWith({ id: 'alice' })
    expect(result).toEqual({ code: 'abc123', expiresAt: 12345 })
  })

  it('never takes an ownerId from client-supplied args — only from ctx.identity', async () => {
    const issue = vi.fn().mockReturnValue({ code: 'xyz', expiresAt: 1 })
    const pairing: DevicePairingStore = { issue, redeem: vi.fn(), dispose: vi.fn() }
    const deps = { pairing } as unknown as IpcDeps
    const ctx = makeCtx('local')

    const handlers = createPairingHandlers(deps, ctx)
    // Even if a malicious/buggy client passed args, the handler ignores them.
    await handlers[IPC.createPairingCode](['not-an-identity', { id: 'attacker' }])

    expect(issue).toHaveBeenCalledWith({ id: 'local' })
    expect(issue).not.toHaveBeenCalledWith({ id: 'attacker' })
  })

  it('throws a clear error when no pairing store is wired (deployment without one)', async () => {
    const deps = {} as unknown as IpcDeps
    const ctx = makeCtx('local')

    const handlers = createPairingHandlers(deps, ctx)
    await expect(handlers[IPC.createPairingCode]([])).rejects.toThrow('Pairing not available')
  })
})
