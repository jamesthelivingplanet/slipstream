import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { TicketSource, TicketSourceSettings } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createTicketHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  return {
    [IPC.listTickets]: async (args) => {
      return deps
        .tickets(ctx.identity.id)
        .listTickets(args[0] as { page?: number; pageSize?: number; query?: string } | undefined)
    },

    [IPC.getLinearKey]: async () => {
      return deps.config.getForOwner!(ctx.identity.id, 'linear.apiKey') ?? null
    },

    [IPC.setLinearKey]: async (args) => {
      deps.config.setForOwner!(ctx.identity.id, 'linear.apiKey', args[0] as string)
      return undefined
    },

    [IPC.getTicketStatus]: async (args) => {
      return deps
        .tickets(ctx.identity.id)
        .getTicketStatus(args[0] as string, args[1] as TicketSource | undefined)
    },

    [IPC.setTicketStatus]: async (args) => {
      return deps
        .tickets(ctx.identity.id)
        .setTicketStatus(args[0] as string, args[1] as string, args[2] as TicketSource | undefined)
    },

    [IPC.getTicketSettings]: async (args) => {
      const src = args[0] as TicketSource
      const provider = deps.ticketProviders?.(ctx.identity.id)?.[src]
      if (!provider) throw new Error(`Unknown ticket source: ${src}`)
      return provider.getSettings()
    },

    [IPC.setTicketSettings]: async (args) => {
      const src = args[0] as TicketSource
      const cfg = args[1] as TicketSourceSettings
      const provider = deps.ticketProviders?.(ctx.identity.id)?.[src]
      if (!provider) throw new Error(`Unknown ticket source: ${src}`)
      provider.setSettings(cfg)
      return undefined
    },

    [IPC.listTicketScopes]: async (args) => {
      const src = args[0] as TicketSource
      const provider = deps.ticketProviders?.(ctx.identity.id)?.[src]
      if (!provider) throw new Error(`Unknown ticket source: ${src}`)
      if (!provider.listScopes) throw new Error('Scope listing not supported')
      return provider.listScopes()
    },
  }
}
