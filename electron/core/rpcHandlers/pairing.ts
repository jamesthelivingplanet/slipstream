import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { PairingCodeDTO } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

/**
 * Self-service device onboarding (docs/SECURITY.md's device-pairing-codes
 * section, docs/IDENTITY-SEAM.md's open item 2). createPairingCode is the
 * authenticated half — it mints a code bound to THIS connection's already-
 * resolved `ctx.identity`, never to a client-supplied ownerId, so a caller
 * can only ever onboard a new device onto their own account. Redemption
 * happens over the unauthenticated POST /pair HTTP endpoint in
 * electron/server/server.ts, against the same deps.pairing store instance.
 */
export function createPairingHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  return {
    [IPC.createPairingCode]: async (): Promise<PairingCodeDTO> => {
      if (!deps.pairing) throw new Error('Pairing not available')
      return deps.pairing.issue(ctx.identity)
    },
  }
}
