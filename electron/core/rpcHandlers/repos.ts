import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { RepoSettings } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createRepoHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { identity, ownedByCaller, requireOwnedRepo } = ctx

  return {
    [IPC.listRepos]: async () => {
      return (await deps.repos.list()).filter(ownedByCaller)
    },

    [IPC.registerRepo]: async (args) => {
      return deps.repos.register(args[0] as string, identity.id)
    },

    [IPC.registerRepoByUrl]: async (args) => {
      return deps.repos.registerByUrl(args[0] as string, identity.id)
    },

    [IPC.removeRepo]: async (args) => {
      const id = args[0] as string
      await requireOwnedRepo(id)
      return deps.repos.remove(id)
    },

    [IPC.getRepoSettings]: async (args) => {
      const id = args[0] as string
      await requireOwnedRepo(id)
      return deps.repos.getSettings(id)
    },

    [IPC.setRepoSettings]: async (args) => {
      const id = args[0] as string
      await requireOwnedRepo(id)
      return deps.repos.setSettings(id, args[1] as RepoSettings)
    },

    [IPC.pickRepo]: async () => {
      throw new Error('pickRepo is not supported without a desktop window')
    },
  }
}
