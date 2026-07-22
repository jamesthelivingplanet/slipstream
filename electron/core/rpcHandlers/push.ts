import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { FcmTokenDTO, NotifyPrefs, PushSubscriptionDTO } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createPushHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { identity } = ctx

  return {
    [IPC.getVapidPublicKey]: async () => {
      return deps.push.getVapidPublicKey()
    },

    [IPC.savePushSubscription]: async (args) => {
      return deps.push.savePushSubscription(args[0] as PushSubscriptionDTO, args[1] as NotifyPrefs)
    },

    [IPC.deletePushSubscription]: async (args) => {
      return deps.push.deletePushSubscription(args[0] as string)
    },

    [IPC.getPushPrefs]: async (args) => {
      return deps.push.getPushPrefs(args[0] as string)
    },

    [IPC.saveFcmToken]: async (args) => {
      return deps.push.saveFcmToken(identity.id, args[0] as FcmTokenDTO)
    },

    [IPC.deleteFcmToken]: async (args) => {
      return deps.push.deleteFcmToken(identity.id, args[0] as string)
    },
  }
}
