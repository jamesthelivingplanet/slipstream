import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import Database from 'better-sqlite3'
import { upsertRepo, allRepos, getRepo, deleteRepo, getRepoSettings, setRepoSettings } from '../db/db.js'
import { getRemoteUrl, resolveRepoPath } from './repoResolve.js'
import type { IRepoRegistry, RepoDTO, RepoSettings } from '../shared/contract.js'

/** Turn an arbitrary string into a lower-kebab-case slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Parse "org/repo" out of a remote URL, returning [org, name]. Falls back to
 *  ["local", dirName] when the URL is null or cannot be parsed. */
function parseOrgName(url: string | null, absPath: string): { org: string; name: string } {
  if (url) {
    const match = url.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (match) return { org: match[1], name: match[2] }
  }
  return { org: 'local', name: basename(absPath) }
}

/** Detect the repo's base branch (origin/HEAD → local HEAD fallback). */
function detectBase(absPath: string): string {
  try {
    const ref = execFileSync(
      'git',
      ['-C', absPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { encoding: 'utf8' },
    ).trim()
    // e.g. "origin/main" → "main"
    return ref.replace(/^origin\//, '')
  } catch {
    // fall back to current HEAD branch name
    try {
      return execFileSync('git', ['-C', absPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    } catch {
      return 'main'
    }
  }
}

/** Backfill remoteUrl for legacy rows registered before the column existed. */
function backfillRemoteUrls(db: Database.Database): void {
  const rows = db.prepare('SELECT id, path FROM repos WHERE remoteUrl IS NULL').all() as { id: string; path: string }[]
  for (const row of rows) {
    const url = getRemoteUrl(row.path)
    if (url) db.prepare('UPDATE repos SET remoteUrl = ? WHERE id = ?').run(url, row.id)
  }
}

export function createRepoRegistry(db: Database.Database, _root: string): IRepoRegistry {
  backfillRemoteUrls(db)
  return {
    async register(absPath: string): Promise<RepoDTO> {
      // Validate: must be inside a git work tree.
      try {
        const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
          cwd: absPath,
          encoding: 'utf8',
        }).trim()
        if (out !== 'true') throw new Error('Not a git repository.')
      } catch (err: unknown) {
        // execFileSync throws on non-zero exit (i.e. not a git repo).
        if (err instanceof Error && err.message === 'Not a git repository.') throw err
        throw new Error('Not a git repository.')
      }

      // Validate: must have at least one commit.
      try {
        execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
          cwd: absPath,
          encoding: 'utf8',
        })
      } catch {
        throw new Error('Repository has no commits.')
      }

      const remoteUrl = getRemoteUrl(absPath)
      const { org, name } = parseOrgName(remoteUrl, absPath)
      const base = detectBase(absPath)
      const id = slugify(`${org}-${name}`)

      const repo: RepoDTO = { id, org, name, base, path: absPath, remoteUrl: remoteUrl ?? undefined }
      upsertRepo(db, repo)
      return repo
    },

    async list(): Promise<RepoDTO[]> {
      return allRepos(db)
    },

    async get(id: string): Promise<RepoDTO | undefined> {
      return getRepo(db, id)
    },

    async resolvePath(id: string): Promise<RepoDTO> {
      const repo = getRepo(db, id)
      if (!repo) throw new Error(`Unknown repo: ${id}`)
      const result = resolveRepoPath(repo)
      if (!result) {
        throw new Error(
          `Repository path no longer exists: ${repo.path}. Re-register it or restore the directory.`,
        )
      }
      if (result.healed) upsertRepo(db, result.repo)
      return result.repo
    },

    async remove(id: string): Promise<void> {
      deleteRepo(db, id)
    },

    async getSettings(id: string): Promise<RepoSettings> {
      return getRepoSettings(db, id)
    },

    async setSettings(id: string, settings: RepoSettings): Promise<void> {
      setRepoSettings(db, id, settings)
    },
  }
}
