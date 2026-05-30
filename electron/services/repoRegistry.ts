import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import Database from 'better-sqlite3'
import { upsertRepo, allRepos, getRepo } from '../db/db.js'
import type { IRepoRegistry, RepoDTO } from '../shared/contract.js'

/** Turn an arbitrary string into a lower-kebab-case slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Parse "org/repo" out of a remote URL, returning [org, name]. Falls back to
 *  ["local", dirName] when the URL cannot be parsed or git fails. */
function parseRemote(absPath: string): { org: string; name: string } {
  try {
    const url = execFileSync('git', ['-C', absPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim()
    // Handles:
    //   https://github.com/org/repo.git
    //   git@github.com:org/repo.git
    const match = url.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (match) return { org: match[1], name: match[2] }
  } catch {
    // no remote — fall through
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

export function createRepoRegistry(db: Database.Database, _root: string): IRepoRegistry {
  return {
    async register(absPath: string): Promise<RepoDTO> {
      const { org, name } = parseRemote(absPath)
      const base = detectBase(absPath)
      const id = slugify(`${org}-${name}`)

      const repo: RepoDTO = { id, org, name, base, path: absPath }
      upsertRepo(db, repo)
      return repo
    },

    async list(): Promise<RepoDTO[]> {
      return allRepos(db)
    },

    async get(id: string): Promise<RepoDTO | undefined> {
      return getRepo(db, id)
    },
  }
}
