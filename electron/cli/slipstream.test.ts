import { describe, it, expect, vi } from 'vitest'
import { runCli, parseArgs, EXIT_OK, EXIT_USAGE, EXIT_FAILED } from './slipstream.js'
import type { CliDeps } from './slipstream.js'
import type { AgentResponse } from '../services/agentRequestSentinel.js'
import { SLIPSTREAM_COMMANDS, renderExitCodes } from '../shared/slipstreamCommands.js'

/**
 * Fake `sendRequest`/`readResponses`/`sleep`/`now` for the new-agent/repos/agents
 * polling loop (TASK-CIOEQ): `respond(id, response)` queues an answer that
 * `readResponses()` returns from then on, and `now`/`sleep` are driven by a fake
 * clock advanced manually — no real timers, so a timeout test doesn't have to
 * actually wait out 60s/15s.
 */
function makeFakeChannel() {
  let clock = 0
  const responses: AgentResponse[] = []
  const sentIds: string[] = []
  return {
    sentIds,
    respond(response: AgentResponse) {
      responses.push(response)
    },
    advance(ms: number) {
      clock += ms
    },
    deps: {
      sendRequest: vi.fn(async () => {
        const id = `req-${sentIds.length + 1}`
        sentIds.push(id)
        return id
      }),
      readResponses: vi.fn(async () => responses.slice()),
      sleep: vi.fn(async (ms: number) => {
        clock += ms
      }),
      now: vi.fn(() => clock),
    } satisfies Pick<CliDeps, 'sendRequest' | 'readResponses' | 'sleep' | 'now'>,
  }
}

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: '/cwd',
    dataDir: '/data',
    sessionId: 'sess-1',
    base: 'main',
    branch: 'feature',
    stdout: vi.fn(),
    stderr: vi.fn(),
    writeStatus: vi.fn().mockResolvedValue(undefined),
    writeOutcome: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    copyArtifact: vi.fn().mockResolvedValue('/data/sessions/sess-1/artifacts/1-report.md'),
    resolveRemote: vi.fn().mockResolvedValue({ host: 'github', org: 'org', name: 'repo' }),
    getToken: vi.fn().mockResolvedValue('tok'),
    push: vi.fn().mockResolvedValue(undefined),
    openMergeRequest: vi.fn().mockResolvedValue({ url: 'https://example.com/mr/1', isNew: true }),
    getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
    writePrSentinel: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue('req-1'),
    readResponses: vi.fn().mockResolvedValue([]),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(0),
    ...overrides,
  }
}

function stdoutText(deps: CliDeps): string {
  return (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('\n')
}

function stderrText(deps: CliDeps): string {
  return (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('\n')
}

describe('parseArgs', () => {
  it('parses --flag value and --flag=value plus positionals', () => {
    expect(parseArgs(['publish', 'a.md', '--title', 'T', '--x=y'])).toEqual({
      flags: { title: 'T', x: 'y' },
      positionals: ['publish', 'a.md'],
    })
  })

  it('returns null when a flag is missing its value', () => {
    expect(parseArgs(['--message'])).toBeNull()
    expect(parseArgs(['--message', '--other', 'x'])).toBeNull()
  })

  it('accepts a bare --json (the one boolean flag) without consuming the next arg', () => {
    expect(parseArgs(['repos', '--json'])).toEqual({
      flags: { json: 'true' },
      positionals: ['repos'],
    })
    // A bare --json followed by another flag must not swallow it as its value.
    expect(parseArgs(['--json', '--other', 'x'])).toEqual({
      flags: { json: 'true', other: 'x' },
      positionals: [],
    })
  })

  it('parses --json=false as an explicit flag value (consumer treats it as OFF)', () => {
    expect(parseArgs(['agents', '--json=false'])).toEqual({
      flags: { json: 'false' },
      positionals: ['agents'],
    })
  })

  it('still rejects a non-boolean flag missing its value (--json is a narrow exception)', () => {
    expect(parseArgs(['--message', '--json'])).toBeNull()
  })
})

describe('runCli', () => {
  describe('help', () => {
    it('prints usage with every command and exits 0', async () => {
      const deps = makeDeps()
      expect(await runCli(['help'], deps)).toBe(EXIT_OK)
      const out = stdoutText(deps)
      // Every command the spec declares must appear in the rendered usage.
      for (const cmd of SLIPSTREAM_COMMANDS.map((c) => c.command)) {
        expect(out).toContain(cmd)
      }
      // The exit-code line is rendered from the shared spec too — and must say
      // "not inside" (regression guard for the drift this consolidation fixed).
      expect(out).toContain(renderExitCodes(', '))
      expect(out).toContain('not inside a Slipstream session')
    })

    it('prints usage when invoked with no command', async () => {
      const deps = makeDeps()
      expect(await runCli([], deps)).toBe(EXIT_OK)
      expect(stdoutText(deps)).toContain('Usage: slipstream')
    })
  })

  describe('task-started', () => {
    it('writes running status (message optional) and nudges the next transitions', async () => {
      const deps = makeDeps()
      expect(await runCli(['task-started'], deps)).toBe(EXIT_OK)
      expect(deps.writeStatus).toHaveBeenCalledWith('running', undefined, undefined)
      const out = stdoutText(deps)
      expect(out).toContain('running')
      expect(out).toContain('task-complete')
    })

    it('passes --message through', async () => {
      const deps = makeDeps()
      await runCli(['task-started', '--message', 'resuming after answer'], deps)
      expect(deps.writeStatus).toHaveBeenCalledWith('running', 'resuming after answer', undefined)
    })
  })

  describe('request-input / task-blocked / approval-request', () => {
    it('request-input writes needs with reason input and reminds about task-started', async () => {
      const deps = makeDeps()
      expect(await runCli(['request-input', '--message', 'which db?'], deps)).toBe(EXIT_OK)
      expect(deps.writeStatus).toHaveBeenCalledWith('needs', 'which db?', 'input')
      expect(stdoutText(deps)).toContain('task-started')
    })

    it('task-blocked writes needs with reason blocked', async () => {
      const deps = makeDeps()
      expect(await runCli(['task-blocked', '--message', 'no docker'], deps)).toBe(EXIT_OK)
      expect(deps.writeStatus).toHaveBeenCalledWith('needs', 'no docker', 'blocked')
    })

    it('approval-request writes needs with reason approval AND appends an approval event', async () => {
      const deps = makeDeps()
      expect(await runCli(['approval-request', '--message', 'drop table?'], deps)).toBe(EXIT_OK)
      expect(deps.writeStatus).toHaveBeenCalledWith('needs', 'drop table?', 'approval')
      expect(deps.appendEvent).toHaveBeenCalledWith('approval', 'drop table?')
    })

    it.each(['request-input', 'task-blocked', 'approval-request'])(
      '%s without --message is a usage error and writes nothing',
      async (cmd) => {
        const deps = makeDeps()
        expect(await runCli([cmd], deps)).toBe(EXIT_USAGE)
        expect(deps.writeStatus).not.toHaveBeenCalled()
        expect(deps.appendEvent).not.toHaveBeenCalled()
      },
    )
  })

  describe('checkpoint', () => {
    it('appends a checkpoint event', async () => {
      const deps = makeDeps()
      expect(await runCli(['checkpoint', '--message', 'tests green'], deps)).toBe(EXIT_OK)
      expect(deps.appendEvent).toHaveBeenCalledWith('checkpoint', 'tests green')
      expect(stdoutText(deps)).toContain('Checkpoint recorded')
    })

    it('requires --message', async () => {
      const deps = makeDeps()
      expect(await runCli(['checkpoint'], deps)).toBe(EXIT_USAGE)
      expect(deps.appendEvent).not.toHaveBeenCalled()
    })
  })

  describe('artifact publish', () => {
    it('copies the file and appends an artifact event with the destination path', async () => {
      const deps = makeDeps()
      expect(await runCli(['artifact', 'publish', 'report.md', '--title', 'Report'], deps)).toBe(
        EXIT_OK,
      )
      expect(deps.copyArtifact).toHaveBeenCalledWith('report.md')
      expect(deps.appendEvent).toHaveBeenCalledWith(
        'artifact',
        'Report',
        '/data/sessions/sess-1/artifacts/1-report.md',
      )
      expect(stdoutText(deps)).toContain('/data/sessions/sess-1/artifacts/1-report.md')
    })

    it('defaults the title to the file basename', async () => {
      const deps = makeDeps()
      await runCli(['artifact', 'publish', 'out/report.md'], deps)
      expect(deps.appendEvent).toHaveBeenCalledWith(
        'artifact',
        'report.md',
        '/data/sessions/sess-1/artifacts/1-report.md',
      )
    })

    it('without a file is a usage error', async () => {
      const deps = makeDeps()
      expect(await runCli(['artifact', 'publish'], deps)).toBe(EXIT_USAGE)
      expect(deps.copyArtifact).not.toHaveBeenCalled()
    })

    it('copy failure exits 3', async () => {
      const deps = makeDeps({ copyArtifact: vi.fn().mockRejectedValue(new Error('ENOENT')) })
      expect(await runCli(['artifact', 'publish', 'missing.md'], deps)).toBe(EXIT_FAILED)
      expect(deps.appendEvent).not.toHaveBeenCalled()
    })
  })

  describe('task-complete', () => {
    it('writes the outcome BEFORE the done status', async () => {
      const order: string[] = []
      const deps = makeDeps({
        writeOutcome: vi.fn().mockImplementation(async () => {
          order.push('outcome')
        }),
        writeStatus: vi.fn().mockImplementation(async () => {
          order.push('status')
        }),
      })
      expect(await runCli(['task-complete', '--summary', 'shipped'], deps)).toBe(EXIT_OK)
      expect(order).toEqual(['outcome', 'status'])
      expect(deps.writeOutcome).toHaveBeenCalledWith('success', 'shipped', undefined)
      expect(deps.writeStatus).toHaveBeenCalledWith('done', undefined)
      expect(stdoutText(deps)).toContain('done')
    })

    it('honors --result and --details', async () => {
      const deps = makeDeps()
      await runCli(
        ['task-complete', '--summary', 's', '--result', 'partial', '--details', 'd'],
        deps,
      )
      expect(deps.writeOutcome).toHaveBeenCalledWith('partial', 's', 'd')
    })

    it('rejects an invalid --result', async () => {
      const deps = makeDeps()
      expect(await runCli(['task-complete', '--summary', 's', '--result', 'bogus'], deps)).toBe(
        EXIT_USAGE,
      )
      expect(deps.writeOutcome).not.toHaveBeenCalled()
    })

    it('requires --summary', async () => {
      const deps = makeDeps()
      expect(await runCli(['task-complete'], deps)).toBe(EXIT_USAGE)
      expect(deps.writeOutcome).not.toHaveBeenCalled()
      expect(deps.writeStatus).not.toHaveBeenCalled()
    })

    it('truncates summary to 4000 and details to 32000 chars', async () => {
      const deps = makeDeps()
      await runCli(
        ['task-complete', '--summary', 'x'.repeat(5000), '--details', 'y'.repeat(40000)],
        deps,
      )
      const [, summary, details] = (deps.writeOutcome as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(summary).toHaveLength(4000)
      expect(details).toHaveLength(32000)
    })
  })

  describe('open-mr', () => {
    it('pushes (best-effort), opens the MR, and writes the pr sentinel', async () => {
      const deps = makeDeps()
      expect(await runCli(['open-mr', '--title', 'My PR'], deps)).toBe(EXIT_OK)
      expect(deps.push).toHaveBeenCalledWith('feature', 'tok', 'git@github.com:org/repo.git')
      expect(deps.openMergeRequest).toHaveBeenCalledWith({
        remoteUrl: 'git@github.com:org/repo.git',
        branch: 'feature',
        base: 'main',
        title: 'My PR',
        body: '',
        token: 'tok',
      })
      expect(deps.writePrSentinel).toHaveBeenCalledWith('https://example.com/mr/1')
      expect(stdoutText(deps)).toContain('https://example.com/mr/1')
    })

    it('still succeeds when push fails (best-effort)', async () => {
      const deps = makeDeps({ push: vi.fn().mockRejectedValue(new Error('already up to date')) })
      expect(await runCli(['open-mr', '--title', 'My PR'], deps)).toBe(EXIT_OK)
      expect(deps.openMergeRequest).toHaveBeenCalled()
      expect(deps.writePrSentinel).toHaveBeenCalledWith('https://example.com/mr/1')
    })

    it('exits 3 with a settings hint when no token is configured', async () => {
      const deps = makeDeps({ getToken: vi.fn().mockResolvedValue(null) })
      expect(await runCli(['open-mr', '--title', 'T'], deps)).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('Settings')
      expect(deps.openMergeRequest).not.toHaveBeenCalled()
    })

    it('exits 3 on an unparseable remote', async () => {
      const deps = makeDeps({
        getRemoteUrl: vi.fn().mockResolvedValue('not-a-remote'),
        resolveRemote: vi.fn().mockResolvedValue(null),
      })
      expect(await runCli(['open-mr', '--title', 'T'], deps)).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('not-a-remote')
      expect(deps.getToken).not.toHaveBeenCalled()
    })

    it('resolves a baseUrl-configured host (gitea) via the config-aware resolver and reads its token', async () => {
      // A Gitea remote has no fixed domain — only deps.resolveRemote (which
      // consults the stored gitea.baseUrl) can claim it. The config-less
      // parseRemote would return null and fail before reading the token.
      const deps = makeDeps({
        getRemoteUrl: vi.fn().mockResolvedValue('https://git.example.com/org/repo.git'),
        resolveRemote: vi.fn().mockResolvedValue({ host: 'gitea', org: 'org', name: 'repo' }),
      })
      expect(await runCli(['open-mr', '--title', 'My PR'], deps)).toBe(EXIT_OK)
      expect(deps.resolveRemote).toHaveBeenCalledWith('https://git.example.com/org/repo.git')
      expect(deps.getToken).toHaveBeenCalledWith('gitea')
      expect(deps.openMergeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ remoteUrl: 'https://git.example.com/org/repo.git' }),
      )
    })

    it('exits 3 when openMergeRequest throws', async () => {
      const deps = makeDeps({
        openMergeRequest: vi.fn().mockRejectedValue(new Error('API rate limited')),
      })
      expect(await runCli(['open-mr', '--title', 'T'], deps)).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('API rate limited')
    })

    it('requires --title', async () => {
      const deps = makeDeps()
      expect(await runCli(['open-mr'], deps)).toBe(EXIT_USAGE)
      expect(deps.openMergeRequest).not.toHaveBeenCalled()
    })
  })

  describe('new-agent (TASK-CIOEQ)', () => {
    it('sends a new-agent request and prints the spawned agent on success', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({
        id: 'req-1',
        ok: true,
        ts: 0,
        data: { tid: 'TASK-ABCDE', sessionId: 's99', branch: 'task-abcde-x', repo: 'acme/api' },
      })

      const code = await runCli(
        ['new-agent', '--repo', 'acme/api', '--title', 'Do the thing'],
        deps,
      )

      expect(code).toBe(EXIT_OK)
      expect(deps.sendRequest).toHaveBeenCalledWith('new-agent', {
        repo: 'acme/api',
        title: 'Do the thing',
        prompt: '',
      })
      const out = stdoutText(deps)
      expect(out).toContain('TASK-ABCDE')
      expect(out).toContain('s99')
      expect(out).toContain('task-abcde-x')
      expect(out).toContain('acme/api')
      expect(out).toContain('slipstream agents')
    })

    it('passes --prompt and --agent through when provided', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({
        id: 'req-1',
        ok: true,
        ts: 0,
        data: { tid: 'T', sessionId: 's', branch: 'b', repo: 'r' },
      })

      await runCli(
        [
          'new-agent',
          '--repo',
          'acme/api',
          '--title',
          'Do it',
          '--prompt',
          'go fix it',
          '--agent',
          'pi',
        ],
        deps,
      )

      expect(deps.sendRequest).toHaveBeenCalledWith('new-agent', {
        repo: 'acme/api',
        title: 'Do it',
        prompt: 'go fix it',
        agent: 'pi',
      })
    })

    it('requires --repo', async () => {
      const deps = makeDeps()
      expect(await runCli(['new-agent', '--title', 'T'], deps)).toBe(EXIT_USAGE)
      expect(deps.sendRequest).not.toHaveBeenCalled()
    })

    it('requires --title', async () => {
      const deps = makeDeps()
      expect(await runCli(['new-agent', '--repo', 'acme/api'], deps)).toBe(EXIT_USAGE)
      expect(deps.sendRequest).not.toHaveBeenCalled()
    })

    it('prints the error and exits 3 on an ok:false response', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: false, ts: 0, error: 'Unknown repo: acme/api' })

      const code = await runCli(
        ['new-agent', '--repo', 'acme/api', '--title', 'Do the thing'],
        deps,
      )

      expect(code).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('Unknown repo: acme/api')
    })

    it('times out after 60s of no matching response and exits 3', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      // Never respond — the fake clock still advances via deps.sleep.

      const code = await runCli(
        ['new-agent', '--repo', 'acme/api', '--title', 'Do the thing'],
        deps,
      )

      expect(code).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('timed out')
      expect(stderrText(deps)).toContain('60s')
      // Confirms the loop actually waited out the full 60s via the fake clock,
      // not e.g. a single readResponses call that happened to time out early.
      expect((deps.sleep as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
    })

    it('--json prints the raw response object instead of the prose sentence', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      const data = {
        tid: 'TASK-ABCDE',
        sessionId: 's99',
        title: 'Do the thing',
        branch: 'task-abcde-x',
        repo: 'acme/api',
        status: 'running',
      }
      channel.respond({ id: 'req-1', ok: true, ts: 0, data })

      const code = await runCli(
        ['new-agent', '--repo', 'acme/api', '--title', 'Do the thing', '--json'],
        deps,
      )

      expect(code).toBe(EXIT_OK)
      const out = stdoutText(deps)
      expect(JSON.parse(out)).toEqual(data)
      expect(out).not.toContain('Spawned agent')
      expect(out).not.toContain('runs independently')
    })
  })

  describe('repos (TASK-CIOEQ)', () => {
    it('renders a table of repos on success', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({
        id: 'req-1',
        ok: true,
        ts: 0,
        data: [
          { id: 'r1', org: 'acme', name: 'api', base: 'main' },
          { id: 'r2', org: 'acme', name: 'web', base: 'develop' },
        ],
      })

      const code = await runCli(['repos'], deps)

      expect(code).toBe(EXIT_OK)
      expect(deps.sendRequest).toHaveBeenCalledWith('repos', {})
      const out = stdoutText(deps)
      expect(out).toContain('acme/api')
      expect(out).toContain('main')
      expect(out).toContain('acme/web')
      expect(out).toContain('develop')
    })

    it('prints a friendly message when there are no repos', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: true, ts: 0, data: [] })

      expect(await runCli(['repos'], deps)).toBe(EXIT_OK)
      expect(stdoutText(deps)).toContain('No repositories')
    })

    it('exits 3 on an ok:false response', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: false, ts: 0, error: 'boom' })

      expect(await runCli(['repos'], deps)).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('boom')
    })

    it('times out after 15s and exits 3', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)

      const code = await runCli(['repos'], deps)

      expect(code).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('timed out')
      expect(stderrText(deps)).toContain('15s')
    })

    it('--json prints the raw array, including the id the table drops', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      const data = [{ id: 'r1', org: 'acme', name: 'api', base: 'main' }]
      channel.respond({ id: 'req-1', ok: true, ts: 0, data })

      expect(await runCli(['repos', '--json'], deps)).toBe(EXIT_OK)
      const out = stdoutText(deps)
      expect(JSON.parse(out)).toEqual(data)
      expect(out).toContain('"id"')
    })

    it('--json on an empty list prints [] rather than the human prose', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: true, ts: 0, data: [] })

      expect(await runCli(['repos', '--json'], deps)).toBe(EXIT_OK)
      expect(stdoutText(deps)).toBe('[]')
    })

    it('--json=false falls back to the human table (only the literal "true" is on)', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({
        id: 'req-1',
        ok: true,
        ts: 0,
        data: [{ id: 'r1', org: 'acme', name: 'api', base: 'main' }],
      })

      expect(await runCli(['repos', '--json=false'], deps)).toBe(EXIT_OK)
      const out = stdoutText(deps)
      expect(out).toContain('acme/api')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('agents (TASK-CIOEQ)', () => {
    it('renders a table of spawned agents on success', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({
        id: 'req-1',
        ok: true,
        ts: 0,
        data: [
          { tid: 'TASK-A', title: 'Fix the thing', status: 'running', repo: 'acme/api' },
          { tid: 'TASK-B', title: 'Ship it', status: 'done', repo: 'acme/web' },
        ],
      })

      const code = await runCli(['agents'], deps)

      expect(code).toBe(EXIT_OK)
      expect(deps.sendRequest).toHaveBeenCalledWith('agents', {})
      const out = stdoutText(deps)
      expect(out).toContain('TASK-A')
      expect(out).toContain('running')
      expect(out).toContain('TASK-B')
      expect(out).toContain('done')
    })

    it('prints a friendly message when nothing has been spawned', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: true, ts: 0, data: [] })

      expect(await runCli(['agents'], deps)).toBe(EXIT_OK)
      expect(stdoutText(deps)).toContain('No agents spawned')
    })

    it('exits 3 on an ok:false response', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: false, ts: 0, error: 'daemon unavailable' })

      expect(await runCli(['agents'], deps)).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('daemon unavailable')
    })

    it('times out after 15s and exits 3', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)

      const code = await runCli(['agents'], deps)

      expect(code).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('timed out')
    })

    it('--json prints the raw array, including fields the table drops', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      const data = [
        {
          tid: 'TASK-A',
          title: 'Fix the thing',
          status: 'running',
          repo: 'acme/api',
          sessionId: 's1',
          branch: 'task-a-fix',
          prUrl: null,
          outcome: null,
        },
      ]
      channel.respond({ id: 'req-1', ok: true, ts: 0, data })

      expect(await runCli(['agents', '--json'], deps)).toBe(EXIT_OK)
      const out = stdoutText(deps)
      expect(JSON.parse(out)).toEqual(data)
      expect(out).toContain('"sessionId"')
      expect(out).toContain('"branch"')
      expect(out).toContain('"prUrl"')
      expect(out).toContain('"outcome"')
    })

    it('--json on an empty list prints [] rather than the human prose', async () => {
      const channel = makeFakeChannel()
      const deps = makeDeps(channel.deps)
      channel.respond({ id: 'req-1', ok: true, ts: 0, data: [] })

      expect(await runCli(['agents', '--json'], deps)).toBe(EXIT_OK)
      expect(stdoutText(deps)).toBe('[]')
    })
  })

  it('unknown command is a usage error naming the command', async () => {
    const deps = makeDeps()
    expect(await runCli(['frobnicate'], deps)).toBe(EXIT_USAGE)
    expect(stderrText(deps)).toContain('frobnicate')
  })

  it('malformed flags are a usage error', async () => {
    const deps = makeDeps()
    expect(await runCli(['task-started', '--message'], deps)).toBe(EXIT_USAGE)
  })
})
