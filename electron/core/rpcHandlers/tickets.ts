import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { TicketSource, TicketSourceSettings } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createTicketHandlers(deps: IpcDeps, _ctx: RpcContext): ChannelHandlerMap {
  return {
    [IPC.listTickets]: async (args) => {
      return deps.tickets.listTickets(
        args[0] as { page?: number; pageSize?: number; query?: string } | undefined,
      )
    },

    [IPC.getLinearKey]: async () => {
      return deps.config.get('linear.apiKey') ?? null
    },

    [IPC.setLinearKey]: async (args) => {
      deps.config.set('linear.apiKey', args[0] as string)
      return undefined
    },

    [IPC.getTicketStatus]: async (args) => {
      return deps.tickets.getTicketStatus(args[0] as string, args[1] as TicketSource | undefined)
    },

    [IPC.setTicketStatus]: async (args) => {
      return deps.tickets.setTicketStatus(
        args[0] as string,
        args[1] as string,
        args[2] as TicketSource | undefined,
      )
    },

    [IPC.getTicketSettings]: async (args) => {
      const src = args[0] as TicketSource
      const provider = deps.ticketProviders?.[src]
      if (!provider) throw new Error(`Unknown ticket source: ${src}`)
      return provider.getSettings()
    },

    [IPC.setTicketSettings]: async (args) => {
      const src = args[0] as TicketSource
      const cfg = args[1] as TicketSourceSettings
      const provider = deps.ticketProviders?.[src]
      if (!provider) throw new Error(`Unknown ticket source: ${src}`)
      provider.setSettings(cfg)
      return undefined
    },

    [IPC.listTicketScopes]: async (args) => {
      const src = args[0] as TicketSource
      const provider = deps.ticketProviders?.[src]
      if (!provider) throw new Error(`Unknown ticket source: ${src}`)
      if (!provider.listScopes) throw new Error('Scope listing not supported')
      return provider.listScopes()
    },
  }
}
