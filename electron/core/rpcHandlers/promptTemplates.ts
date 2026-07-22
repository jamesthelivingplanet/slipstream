import { randomUUID } from 'node:crypto'
import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { PromptTemplateDTO } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createPromptTemplateHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { identity, ownedByCaller, requireOwnedRepo } = ctx

  return {
    [IPC.listPromptTemplates]: async (args) => {
      const repoId = args[0] as string
      await requireOwnedRepo(repoId)
      return deps.promptTemplates.list(repoId).filter(ownedByCaller)
    },

    [IPC.savePromptTemplate]: async (args) => {
      const input = args[0] as { id?: string; repoId: string; name: string; body: string }
      await requireOwnedRepo(input.repoId)
      if (!input.name?.trim()) throw new Error('Template name must not be empty')
      if (!input.body?.trim()) throw new Error('Template body must not be empty')
      let id = input.id
      let createdAt = Date.now()
      if (id !== undefined) {
        // Updating an existing template: missing and other-owner rows throw
        // the identical error — no existence leak across owners.
        const existing = deps.promptTemplates.get(id)
        if (!existing || !ownedByCaller(existing)) throw new Error(`Template not found: ${id}`)
        createdAt = existing.createdAt
      } else {
        id = randomUUID()
      }
      const dto: PromptTemplateDTO = {
        id,
        repoId: input.repoId,
        name: input.name.trim(),
        body: input.body,
        createdAt,
        ownerId: identity.id,
      }
      deps.promptTemplates.upsert(dto)
      return dto
    },

    [IPC.deletePromptTemplate]: async (args) => {
      const id = args[0] as string
      // Missing and other-owner rows throw the identical error — no
      // existence leak across owners.
      const existing = deps.promptTemplates.get(id)
      if (!existing || !ownedByCaller(existing)) throw new Error(`Template not found: ${id}`)
      deps.promptTemplates.delete(id)
      return undefined
    },
  }
}
