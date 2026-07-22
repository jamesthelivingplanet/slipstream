import type { IpcDeps } from '../../ipc.js'
import type { RepoDTO, SessionDTO } from '../../shared/contract.js'

/** Resolves a session's worktree cwd (needed for pi's usage reader, which
 *  is keyed on cwd rather than a captured transcript/session id). Fresh
 *  per-call repo cache so a batch (usageSummary/listSessionHistory) only
 *  resolves each repo once. Never throws — usage reads must not fail a
 *  listing just because a repo/worktree can't be resolved right now. */
export function makeCwdForSession(
  deps: Pick<IpcDeps, 'repos' | 'worktrees'>,
): (s: SessionDTO) => Promise<string | null> {
  const repoCache = new Map<string, RepoDTO>()
  return async function cwdForSession(s: SessionDTO): Promise<string | null> {
    try {
      let repo = repoCache.get(s.repoId)
      if (!repo) {
        repo = await deps.repos.resolvePath(s.repoId)
        repoCache.set(s.repoId, repo)
      }
      return deps.worktrees.pathFor(repo, s.branch)
    } catch {
      return null
    }
  }
}
