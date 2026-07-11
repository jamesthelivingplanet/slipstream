import { describe, it, expect, vi } from 'vitest'
import { runCli, parseArgs, EXIT_OK, EXIT_USAGE, EXIT_FAILED } from './slipstream.js'
import type { CliDeps } from './slipstream.js'

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
    getToken: vi.fn().mockResolvedValue('tok'),
    push: vi.fn().mockResolvedValue(undefined),
    openMergeRequest: vi.fn().mockResolvedValue({ url: 'https://example.com/mr/1', isNew: true }),
    getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
    writePrSentinel: vi.fn().mockResolvedValue(undefined),
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
})

describe('runCli', () => {
  describe('help', () => {
    it('prints usage with every command and exits 0', async () => {
      const deps = makeDeps()
      expect(await runCli(['help'], deps)).toBe(EXIT_OK)
      const out = stdoutText(deps)
      for (const cmd of [
        'task-started',
        'request-input',
        'task-blocked',
        'approval-request',
        'checkpoint',
        'artifact publish',
        'task-complete',
        'open-mr',
      ]) {
        expect(out).toContain(cmd)
      }
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
      const deps = makeDeps({ getRemoteUrl: vi.fn().mockResolvedValue('not-a-remote') })
      expect(await runCli(['open-mr', '--title', 'T'], deps)).toBe(EXIT_FAILED)
      expect(stderrText(deps)).toContain('not-a-remote')
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
