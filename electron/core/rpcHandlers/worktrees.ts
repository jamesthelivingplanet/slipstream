import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { WorktreeUpdateMode } from '../../shared/contract.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createWorktreeHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { requireOwnedRepo, requireSafeBranch } = ctx

  return {
    [IPC.worktreeStatus]: async (args) => {
      const repoId = args[0] as string
      const branch = requireSafeBranch(args[1] as string)
      const repo = await requireOwnedRepo(repoId)
      return deps.worktrees.status(repo, branch)
    },

    [IPC.worktreeDiff]: async (args) => {
      const repoId = args[0] as string
      const branch = requireSafeBranch(args[1] as string)
      const repo = await requireOwnedRepo(repoId)
      return deps.worktrees.diff(repo, branch)
    },

    [IPC.worktreeUpdateFromBase]: async (args) => {
      const repoId = args[0] as string
      const branch = requireSafeBranch(args[1] as string)
      const mode = args[2] as WorktreeUpdateMode
      const repo = await requireOwnedRepo(repoId)
      return deps.worktrees.updateFromBase(repo, branch, { mode })
    },

    [IPC.openInEditor]: async (args) => {
      const input = args[0] as { repoId: string; branch: string; mobile?: boolean }
      const branch = requireSafeBranch(input.branch)
      const repo = await requireOwnedRepo(input.repoId)
      const cwd = deps.worktrees.pathFor(repo, branch)
      const desktop = deps.config.get('editor.command') ?? 'code'
      const mobileCmd = (deps.config.get('editor.mobileCommand') ?? '').trim()
      const command = input.mobile && mobileCmd ? mobileCmd : desktop
      if (!command.trim()) throw new Error('No editor configured. Set one in Settings → Behavior.')
      await deps.editor.open(command, cwd)
      return undefined
    },

    [IPC.runApp]: async (args) => {
      const { repoId, branch: rawBranch } = args[0] as { repoId: string; branch: string }
      const branch = requireSafeBranch(rawBranch)
      const repo = await requireOwnedRepo(repoId)
      const settings = await deps.repos.getSettings(repoId)
      if (!settings.startCmd.trim()) return { started: false, reason: 'no-start-command' }
      const cwd = deps.worktrees.pathFor(repo, branch)
      const key = `${repoId} ${branch}`
      let port: number | undefined
      try {
        port = await deps.ports.claim(cwd, 'web')
      } catch {
        port = undefined
      }
      const { pid, reused } = await deps.appRunner.run(
        key,
        cwd,
        settings.startCmd,
        port !== undefined ? { PORT: String(port) } : undefined,
      )
      // When this machine is on a tailnet (i.e. Slipstream itself is being
      // reached over Tailscale), mirror the app there too. Best-effort: a
      // failed/unavailable expose must not fail the run.
      let url: string | undefined
      if (port !== undefined && deps.tailscale) {
        try {
          url = (await deps.tailscale.expose(key, port)) ?? undefined
        } catch {
          url = undefined
        }
      }
      return { started: true, port, pid, reused, url }
    },

    [IPC.stopApp]: async (args) => {
      const { repoId, branch } = args[0] as { repoId: string; branch: string }
      await requireOwnedRepo(repoId)
      const key = `${repoId} ${branch}`
      const stopped = await deps.appRunner.stop(key)
      try {
        await deps.tailscale?.unexpose(key)
      } catch {
        // best effort — the serve mount is cheap to leave behind
      }
      return { stopped }
    },

    [IPC.appStatus]: async (args) => {
      const { repoId, branch } = args[0] as { repoId: string; branch: string }
      await requireOwnedRepo(repoId)
      const key = `${repoId} ${branch}`
      const running = deps.appRunner.isRunning(key)
      return { running, url: running ? (deps.tailscale?.urlFor(key) ?? undefined) : undefined }
    },
  }
}
