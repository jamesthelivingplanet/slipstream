import path from 'node:path'
import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { BackendKind } from '../../shared/contract.js'
import { checkSlipstreamCli, lastCliActivity } from '../../services/cliHealth.js'
import { diagnoseRepos, realRepoProbes } from '../../services/diagnostics.js'
import { findAgentCli, binForKind } from '../../services/cliProbe.js'
import { APP_VERSION, GIT_SHA } from '../../shared/version.js'
import { SCHEMA_VERSION } from '../../db/migrations.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createDiagnosticsHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { ownedByCaller } = ctx

  return {
    [IPC.getCliStatus]: async () => {
      if (!deps.agentCli)
        return { up: false, commands: [], checkedAt: Date.now(), error: 'CLI not configured' }
      const res = await checkSlipstreamCli({
        electronPath: deps.agentCli.electronPath,
        cliJsPath: deps.agentCli.cliJsPath,
        dataDir: deps.agentCli.dataDir,
      })
      const lastActivityAt = await lastCliActivity(deps.agentCli.dataDir)
      return { ...res, checkedAt: Date.now(), lastActivityAt }
    },

    [IPC.getDiagnostics]: async () => {
      const port = Number(process.env.SLIPSTREAM_PORT) || undefined
      const bind = process.env.SLIPSTREAM_BIND ?? '127.0.0.1'
      const dataDir = deps.agentCli?.dataDir ?? ''
      const repos = (await deps.repos.list()).filter(ownedByCaller)
      return {
        daemon: {
          wsUrl: `ws://${bind}:${port}/rpc`,
          httpBase: `http://${bind}:${port}`,
          port,
          pid: process.pid,
          mode: process.env.SLIPSTREAM_DAEMON_URL ? 'remote' : 'local',
          dataDir,
          dbPath: dataDir ? path.join(dataDir, 'slipstream.db') : '',
        },
        versions: {
          app: APP_VERSION,
          gitSha: GIT_SHA,
          schema: SCHEMA_VERSION,
          node: process.versions.node,
          electron: process.versions.electron,
          v8: process.versions.v8,
          chrome: process.versions.chrome,
        },
        repos: diagnoseRepos(repos, realRepoProbes),
      }
    },

    [IPC.checkAgentCli]: async (args) => {
      const kind = args[0] as BackendKind
      const bin = binForKind(kind)
      const found = findAgentCli(kind)
      return { kind, bin, found: found !== null, path: found ?? undefined }
    },
  }
}
