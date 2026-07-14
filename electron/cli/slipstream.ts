/**
 * slipstream — the agent-facing session CLI (FLO-104). Replaces the stdio MCP
 * server as the integration surface: agents run `slipstream <command>` from
 * their worktree and the app picks the effects up through the same sentinel
 * files the MCP used to write (status.json / outcome.json / pr.json) plus the
 * new append-only events.ndjson (checkpoint / artifact / approval).
 *
 * Identity comes from the session env (SLIPSTREAM_DATA_DIR / SESSION_ID /
 * BASE / BRANCH) injected into the PTY — no daemon token is ever exposed to
 * the agent. Command handling is pure (`runCli` + injected `CliDeps`) so tests
 * run without Electron or a DB; `main()` wires the real deps, dynamic-importing
 * the DB/config layer only for `open-mr` (the one command that needs a token).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitHost, OutcomeResult, NeedsReason, AgentEventKind } from '../shared/contract.js'
import { STATUS_SENTINEL_FILE } from '../services/statusSentinel.js'
import { OUTCOME_SENTINEL_FILE } from '../services/outcomeSentinel.js'
import { AGENT_EVENTS_FILE } from '../services/agentEventsSentinel.js'
import { resolveRemote, createGitDriver } from '../services/gitDriver.js'
import type { GitHostConfig } from '../services/gitDriver.js'
import type { IConfigStore } from '../services/configStore.js'

const execFile = promisify(_execFile)

export const EXIT_OK = 0
export const EXIT_USAGE = 1
export const EXIT_NO_SESSION = 2
export const EXIT_FAILED = 3

const VALID_OUTCOME_RESULTS: OutcomeResult[] = ['success', 'partial', 'failure']
const MAX_SUMMARY_LEN = 4000
const MAX_DETAILS_LEN = 32000

export interface CliDeps {
  cwd: string
  dataDir: string
  sessionId: string
  base: string
  branch: string
  stdout(text: string): void
  stderr(text: string): void
  writeStatus(
    state: 'running' | 'needs' | 'done',
    message?: string,
    reason?: NeedsReason,
  ): Promise<void>
  writeOutcome(result: OutcomeResult, summary: string, details?: string): Promise<void>
  appendEvent(kind: AgentEventKind, message?: string, artifactPath?: string): Promise<void>
  /** Copy `file` into the session's artifact store; resolves the destination path. */
  copyArtifact(file: string): Promise<string>
  /** open-mr only — config-aware remote resolution. Self-hosted providers
   *  (Gitea/Forgejo) match by their stored baseUrl, not a fixed domain, so
   *  the resolver must consult the config DB (loaded lazily in main()) —
   *  a bare parseRemote() with empty config would miss them. */
  resolveRemote(remoteUrl: string): Promise<{ host: GitHost; org: string; name: string } | null>
  /** open-mr only — loads the config DB lazily in main(). */
  getToken(host: GitHost): Promise<string | null>
  push(branch: string, token?: string, remoteUrl?: string): Promise<void>
  openMergeRequest(input: {
    remoteUrl: string
    branch: string
    base: string
    title: string
    body: string
    token: string
  }): Promise<{ url: string; isNew: boolean }>
  getRemoteUrl(cwd: string): Promise<string>
  writePrSentinel(url: string): Promise<void>
}

/**
 * Success text always names what was just recorded plus the next expected
 * transition (mirrors the MCP-era reportStatusReminder — tests assert on it).
 * The agent reads command output, so this closes the loop on the transition
 * that gets dropped most: resuming with task-started after waiting.
 */
function nudge(state: 'running' | 'needs' | 'done', reason?: NeedsReason): string {
  switch (state) {
    case 'needs': {
      const what =
        reason === 'blocked'
          ? 'blocked'
          : reason === 'approval'
            ? 'awaiting approval'
            : 'needs input'
      return (
        `Status reported: ${what}. The app now shows you as waiting on the user. ` +
        'When they respond and you resume work, run `slipstream task-started` as your ' +
        'very first action — before investigating or replying.'
      )
    }
    case 'running':
      return (
        'Status reported: running. Report again the moment your state next changes: ' +
        '`slipstream request-input`/`task-blocked`/`approval-request` if you stop to wait ' +
        'on the user, or `slipstream task-complete` as your final action once the ticket ' +
        'is complete and the merge request is open.'
      )
    case 'done':
      return 'Status reported: done.'
  }
}

const USAGE = `Usage: slipstream <command> [options]

Report your working state to the Slipstream app. Commands:

  task-started [--message <text>]        You started or resumed working.
  request-input --message <text>         You stopped to wait on the user's reply.
  task-blocked --message <text>          You cannot proceed (env broken, missing dep).
  approval-request --message <text>      You need an explicit go-ahead first.
  checkpoint --message <text>            Record a progress milestone (durable).
  artifact publish <file> [--title <t>]  Copy a file into the session's artifact store.
  task-complete --summary <text>         Record the final outcome, then status done.
      [--result success|partial|failure] [--details <text>]
  open-mr --title <t> [--description <d>] Push (best-effort) and open the merge request.
  help [command]                         Show usage.

Exit codes: 0 ok, 1 usage error, 2 not in a Slipstream session, 3 operation failed.`

/** Hand-rolled flag parser: `--flag value` and `--flag=value`; the rest are positionals. */
export function parseArgs(
  args: string[],
): { flags: Record<string, string>; positionals: string[] } | null {
  const flags: Record<string, string> = {}
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const value = args[i + 1]
        if (value === undefined || value.startsWith('--')) return null
        flags[arg.slice(2)] = value
        i++
      }
    } else {
      positionals.push(arg)
    }
  }
  return { flags, positionals }
}

function usageError(deps: CliDeps, message: string): number {
  deps.stderr(`slipstream: ${message}\n\n${USAGE}`)
  return EXIT_USAGE
}

async function statusCommand(
  deps: CliDeps,
  state: 'running' | 'needs',
  reason: NeedsReason | undefined,
  flags: Record<string, string>,
  messageRequired: boolean,
): Promise<number> {
  const message = flags['message']
  if (messageRequired && !message) {
    return usageError(deps, '--message is required for this command')
  }
  await deps.writeStatus(state, message, reason)
  if (reason === 'approval') {
    await deps.appendEvent('approval', message)
  }
  deps.stdout(nudge(state, reason))
  return EXIT_OK
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === 'help') {
    deps.stdout(USAGE)
    return EXIT_OK
  }

  const parsed = parseArgs(rest)
  if (!parsed) return usageError(deps, 'malformed flags (every --flag needs a value)')
  const { flags, positionals } = parsed

  try {
    switch (command) {
      case 'task-started':
        return await statusCommand(deps, 'running', undefined, flags, false)

      case 'request-input':
        return await statusCommand(deps, 'needs', 'input', flags, true)

      case 'task-blocked':
        return await statusCommand(deps, 'needs', 'blocked', flags, true)

      case 'approval-request':
        return await statusCommand(deps, 'needs', 'approval', flags, true)

      case 'checkpoint': {
        const message = flags['message']
        if (!message) return usageError(deps, '--message is required for checkpoint')
        await deps.appendEvent('checkpoint', message)
        deps.stdout('Checkpoint recorded.')
        return EXIT_OK
      }

      case 'artifact': {
        if (positionals[0] !== 'publish' || !positionals[1]) {
          return usageError(deps, 'usage: slipstream artifact publish <file> [--title <t>]')
        }
        const dest = await deps.copyArtifact(positionals[1])
        await deps.appendEvent('artifact', flags['title'] ?? path.basename(positionals[1]), dest)
        deps.stdout(`Artifact published: ${dest}`)
        return EXIT_OK
      }

      case 'task-complete': {
        const summary = flags['summary']
        if (!summary) return usageError(deps, '--summary is required for task-complete')
        const result = (flags['result'] ?? 'success') as OutcomeResult
        if (!VALID_OUTCOME_RESULTS.includes(result)) {
          return usageError(deps, `invalid --result: ${flags['result']} (success|partial|failure)`)
        }
        // Outcome first, done second: the done transition is what consumers
        // (write-back, notifications) react to, so the record must exist by then.
        await deps.writeOutcome(
          result,
          summary.slice(0, MAX_SUMMARY_LEN),
          flags['details']?.slice(0, MAX_DETAILS_LEN),
        )
        await deps.writeStatus('done', flags['message'])
        deps.stdout(`Outcome recorded: ${result}. ${nudge('done')}`)
        return EXIT_OK
      }

      case 'open-mr': {
        const title = flags['title']
        if (!title) return usageError(deps, '--title is required for open-mr')
        const description = flags['description'] ?? ''
        const remoteUrl = await deps.getRemoteUrl(deps.cwd)
        const remote = await deps.resolveRemote(remoteUrl)
        if (!remote) {
          deps.stderr(`Cannot parse remote URL: ${remoteUrl}`)
          return EXIT_FAILED
        }
        const token = await deps.getToken(remote.host)
        if (!token) {
          deps.stderr('No git token found. Set it in Settings → Integrations.')
          return EXIT_FAILED
        }
        // Best-effort push — the agent should already have pushed via its own
        // shell; ignore failures here (e.g. branch already pushed) and continue.
        try {
          await deps.push(deps.branch, token, remoteUrl)
        } catch {
          /* best-effort; branch may already be pushed */
        }
        const result = await deps.openMergeRequest({
          remoteUrl,
          branch: deps.branch,
          base: deps.base,
          title,
          body: description,
          token,
        })
        await deps.writePrSentinel(result.url)
        const action = result.isNew ? 'Opened' : 'Found existing'
        deps.stdout(`${action} merge/pull request: ${result.url}`)
        return EXIT_OK
      }

      default:
        return usageError(deps, `unknown command: ${command}`)
    }
  } catch (err: unknown) {
    deps.stderr(err instanceof Error ? err.message : String(err))
    return EXIT_FAILED
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const stdout = (text: string) => process.stdout.write(text + '\n')
  const stderr = (text: string) => process.stderr.write(text + '\n')

  // help must work outside a session (used by the app's own health check).
  const dataDir = process.env.SLIPSTREAM_DATA_DIR ?? ''
  const sessionId = process.env.SLIPSTREAM_SESSION_ID ?? ''
  if ((!dataDir || !sessionId) && argv[0] !== 'help' && argv.length > 0) {
    stderr(
      'slipstream: not inside a Slipstream session ' +
        '(SLIPSTREAM_DATA_DIR / SLIPSTREAM_SESSION_ID are unset).',
    )
    process.exit(EXIT_NO_SESSION)
  }

  const base = process.env.SLIPSTREAM_BASE ?? 'main'
  const cwd = process.cwd()
  let branch = process.env.SLIPSTREAM_BRANCH ?? ''
  if (!branch) {
    try {
      const { stdout: out } = await execFile('git', [
        '-C',
        cwd,
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ])
      branch = out.trim()
    } catch {
      branch = ''
    }
  }

  const sentinelDir = path.join(dataDir, 'sessions', sessionId)
  async function writeSentinelFile(file: string, content: string): Promise<void> {
    await fs.promises.mkdir(sentinelDir, { recursive: true })
    await fs.promises.writeFile(path.join(sentinelDir, file), content)
  }

  // Lazily-loaded, cached config store (better-sqlite3/safeStorage) — only
  // 'open-mr' needs it, so every other command stays dependency-light. The
  // synchronous getHostConfig reads the cache; it's only ever invoked (via
  // deps.resolveRemote and driver.push/driver.openMergeRequest below) after
  // open-mr's first await of loadConfigStore() (deps.resolveRemote is the
  // command's first config touch), so the cache is guaranteed populated by
  // the time it's read.
  let cachedConfigStore: IConfigStore | undefined
  async function loadConfigStore(): Promise<IConfigStore> {
    if (!cachedConfigStore) {
      const { openDb } = await import('../db/db.js')
      const { createConfigStore, createSafeStorageEncryptor } =
        await import('../services/configStore.js')
      const db = openDb(path.join(dataDir, 'slipstream.db'))
      cachedConfigStore = createConfigStore(db, { encryptor: createSafeStorageEncryptor() })
    }
    return cachedConfigStore
  }

  const getHostConfig = (host: GitHost): GitHostConfig => ({
    token: cachedConfigStore?.get(`${host}.token`),
    username: cachedConfigStore?.get(`${host}.username`),
    baseUrl: cachedConfigStore?.get(`${host}.baseUrl`),
  })

  const driver = createGitDriver({ getHostConfig })

  const deps: CliDeps = {
    cwd,
    dataDir,
    sessionId,
    base,
    branch,
    stdout,
    stderr,
    async writeStatus(state, message, reason) {
      await writeSentinelFile(
        STATUS_SENTINEL_FILE,
        JSON.stringify({ state, message, reason, ts: Date.now() }),
      )
    },
    async writeOutcome(result, summary, details) {
      await writeSentinelFile(
        OUTCOME_SENTINEL_FILE,
        JSON.stringify({
          result,
          summary,
          ...(details !== undefined ? { details } : {}),
          ts: Date.now(),
        }),
      )
    },
    async appendEvent(kind, message, artifactPath) {
      await fs.promises.mkdir(sentinelDir, { recursive: true })
      const line = JSON.stringify({
        kind,
        ...(message !== undefined ? { message } : {}),
        ...(artifactPath !== undefined ? { path: artifactPath } : {}),
        ts: Date.now(),
      })
      await fs.promises.appendFile(path.join(sentinelDir, AGENT_EVENTS_FILE), line + '\n')
    },
    async copyArtifact(file) {
      const src = path.resolve(cwd, file)
      await fs.promises.access(src, fs.constants.R_OK)
      const artifactsDir = path.join(sentinelDir, 'artifacts')
      await fs.promises.mkdir(artifactsDir, { recursive: true })
      const dest = path.join(artifactsDir, `${Date.now()}-${path.basename(src)}`)
      await fs.promises.copyFile(src, dest)
      return dest
    },
    async resolveRemote(remoteUrl) {
      // Config-aware: a Gitea/Forgejo remote only matches via the stored
      // gitea.baseUrl, so the config DB must be loaded before resolving.
      await loadConfigStore()
      return resolveRemote(remoteUrl, getHostConfig)
    },
    async getToken(host) {
      const configStore = await loadConfigStore()
      return configStore.get(`${host}.token`) ?? null
    },
    async push(br, token, remoteUrl) {
      await driver.push(cwd, br, { token, remoteUrl })
    },
    async openMergeRequest(input) {
      return driver.openMergeRequest(input)
    },
    async getRemoteUrl(dir) {
      const { stdout: out } = await execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'])
      return out.trim()
    },
    async writePrSentinel(url) {
      await writeSentinelFile('pr.json', JSON.stringify({ url }))
    },
  }

  process.exit(await runCli(argv, deps))
}

// Only auto-start when run as a script (not imported as a module)
if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
