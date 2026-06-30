import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { upsertRepo, allRepos, getRepo, deleteRepo, getRepoSettings, setRepoSettings } from '../db/db.js'
import { getRemoteUrl, resolveRepoPath, cloneRepo, isWorkTree } from './repoResolve.js'
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

/** Build a RepoDTO from an on-disk checkout (org/name from remote URL when
 *  present, base branch detected from the checkout). */
function buildRepoDTO(absPath: string, remoteUrl: string | null, ownerId: string): RepoDTO {
  const { org, name } = parseOrgName(remoteUrl, absPath)
  const base = detectBase(absPath)
  const id = slugify(`${org}-${name}`)
  return { id, org, name, base, path: absPath, remoteUrl: remoteUrl ?? undefined, ownerId }
}

export function createRepoRegistry(db: Database.Database, root: string): IRepoRegistry {
  backfillRemoteUrls(db)
  const managedPath = (id: string) => join(root, '.repositories', id)
  return {
    async register(absPath: string, ownerId = 'local'): Promise<RepoDTO> {
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
      const repo = buildRepoDTO(absPath, remoteUrl, ownerId)
      upsertRepo(db, repo)
      return repo
    },

    async registerByUrl(remoteUrl: string, ownerId = 'local'): Promise<RepoDTO> {
      const trimmed = remoteUrl.trim()
      if (!trimmed) throw new Error('Remote URL is required.')
      // Derive the managed destination from the URL so the id is stable & deterministic.
      const { org, name } = parseOrgName(trimmed, trimmed)
      const id = slugify(`${org}-${name}`)
      const dest = managedPath(id)

      // Idempotent: an existing managed clone with the same remote is reused.
      if (isWorkTree(dest) && getRemoteUrl(dest) === trimmed) {
        const repo = buildRepoDTO(dest, trimmed, ownerId)
        upsertRepo(db, repo)
        return repo
      }
      // Stale/partial leftover in our managed dir — safe to remove and re-clone.
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })

      mkdirSync(join(root, '.repositories'), { recursive: true })
      cloneRepo(trimmed, dest)

      const repo = buildRepoDTO(dest, getRemoteUrl(dest), ownerId)
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
        // Managed clone went missing — re-provision it on demand.
        if (repo.remoteUrl && repo.path === managedPath(repo.id)) {
          if (existsSync(repo.path)) rmSync(repo.path, { recursive: true, force: true })
          mkdirSync(join(root, '.repositories'), { recursive: true })
          cloneRepo(repo.remoteUrl, repo.path)
          upsertRepo(db, repo)
          return repo
        }
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
