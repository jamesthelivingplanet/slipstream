import type { IpcDeps } from '../../ipc.js'
import { IPC, BACKEND_KINDS } from '../../shared/contract.js'
import type {
  AgentArgsConfig,
  EditorConfig,
  GcPolicy,
  GitHost,
  SchedulerPolicy,
} from '../../shared/contract.js'
import { GIT_PROVIDERS } from '../../services/gitProviders/registry.js'
import { parseAgentArgs } from '../../shared/agentCli.js'
import { readGcPolicy, writeGcPolicy } from '../../services/sessionReaper.js'
import { readSchedulerPolicy, writeSchedulerPolicy } from '../../services/sessionScheduler.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

const GIT_HOST_IDS = new Set(GIT_PROVIDERS.map((p) => p.meta.id))

function isGitHost(host: unknown): host is GitHost {
  return typeof host === 'string' && GIT_HOST_IDS.has(host as GitHost)
}

export function createConfigHandlers(deps: IpcDeps, _ctx: RpcContext): ChannelHandlerMap {
  return {
    [IPC.getEditorConfig]: async () => {
      return {
        command: deps.config.get('editor.command') ?? 'code',
        mobileCommand: deps.config.get('editor.mobileCommand') ?? '',
      }
    },

    [IPC.setEditorConfig]: async (args) => {
      const cfg = args[0] as EditorConfig
      deps.config.set('editor.command', cfg.command ?? '')
      deps.config.set('editor.mobileCommand', cfg.mobileCommand ?? '')
      return undefined
    },

    [IPC.getAgentArgs]: async () => {
      const cfg: AgentArgsConfig = {}
      for (const kind of BACKEND_KINDS) {
        const v = deps.config.get(`agentArgs.${kind}`)
        if (v && v.trim()) cfg[kind] = v
      }
      return cfg
    },

    [IPC.setAgentArgs]: async (args) => {
      const cfg = (args[0] ?? {}) as AgentArgsConfig
      const next: Array<[string, string]> = []
      for (const kind of BACKEND_KINDS) {
        const raw = (cfg[kind] ?? '').trim()
        // Validate every value before writing any, so a malformed entry rejects
        // the whole save (same guard startSession applies) without a partial write.
        if (raw) parseAgentArgs(raw)
        next.push([`agentArgs.${kind}`, raw])
      }
      for (const [key, raw] of next) deps.config.set(key, raw)
      return undefined
    },

    [IPC.getGitToken]: async (args) => {
      const host = args[0]
      if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
      return deps.config.get(`${host}.token`) ?? null
    },

    [IPC.setGitToken]: async (args) => {
      const host = args[0]
      if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
      deps.config.set(`${host}.token`, args[1] as string)
      return undefined
    },

    [IPC.listGitProviders]: async () => {
      return GIT_PROVIDERS.map((p) => ({ ...p.meta }))
    },

    [IPC.getGitHostConfig]: async (args) => {
      const host = args[0]
      if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
      return {
        token: deps.config.get(`${host}.token`) ?? null,
        username: deps.config.get(`${host}.username`) ?? null,
        baseUrl: deps.config.get(`${host}.baseUrl`) ?? null,
      }
    },

    [IPC.setGitHostConfig]: async (args) => {
      const host = args[0]
      if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
      const cfg = (args[1] ?? {}) as { token?: string; username?: string; baseUrl?: string }
      if (cfg.token !== undefined) deps.config.set(`${host}.token`, cfg.token)
      if (cfg.username !== undefined) deps.config.set(`${host}.username`, cfg.username)
      if (cfg.baseUrl !== undefined) deps.config.set(`${host}.baseUrl`, cfg.baseUrl)
      return undefined
    },

    [IPC.getGcPolicy]: async () => {
      return readGcPolicy(deps.config)
    },

    [IPC.setGcPolicy]: async (args) => {
      writeGcPolicy(deps.config, args[0] as GcPolicy)
      return undefined
    },

    [IPC.getSchedulerPolicy]: async () => {
      return readSchedulerPolicy(deps.config)
    },

    [IPC.setSchedulerPolicy]: async (args) => {
      writeSchedulerPolicy(deps.config, args[0] as SchedulerPolicy)
      void deps.scheduler?.drain() // raising the cap frees slots immediately
      return undefined
    },
  }
}
