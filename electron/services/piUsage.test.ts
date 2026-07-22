import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPiUsage } from './piUsage.js'
import { piSessionDirFor } from './piSessions.js'

let root: string
const cwd = '/home/user/work/repo-wt'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slipstream-pi-usage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeJsonl(file: string, lines: string[]): void {
  const dir = piSessionDirFor(cwd, root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), lines.join('\n'))
}

/** VERIFIED real assistant message-entry shape (see piSessions/piUsage docs). */
function assistantEntry(opts: {
  input?: number
  output?: number
  reasoning?: number
  cacheWrite?: number
  cacheRead?: number
  costTotal?: number
  model?: string
}): string {
  return JSON.stringify({
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-5',
      usage: {
        input: opts.input ?? 0,
        output: opts.output ?? 0,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        reasoning: opts.reasoning ?? 0,
        totalTokens: (opts.input ?? 0) + (opts.output ?? 0),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: opts.costTotal ?? 0,
        },
      },
    },
  })
}

describe('readPiUsage', () => {
  it('returns exists:false with zero tokens when cwd is null', async () => {
    const u = await readPiUsage('s1', null, root)
    expect(u.exists).toBe(false)
    expect(u.turns).toBe(0)
    expect(u.costUsd).toBe(0)
    expect(u.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 })
  })

  it('returns exists:false when the session dir is missing', async () => {
    const u = await readPiUsage('s1', '/nowhere', root)
    expect(u.exists).toBe(false)
  })

  it('returns exists:false when the dir exists but has zero .jsonl files', async () => {
    mkdirSync(piSessionDirFor(cwd, root), { recursive: true })
    const u = await readPiUsage('s1', cwd, root)
    expect(u.exists).toBe(false)
  })

  it('sums input/output/reasoning/cache tokens + cost across one file', async () => {
    writeJsonl('run1.jsonl', [
      assistantEntry({
        input: 100,
        output: 50,
        reasoning: 20,
        cacheWrite: 200,
        cacheRead: 300,
        costTotal: 0.05,
      }),
      assistantEntry({ input: 10, output: 5, costTotal: 0.01 }),
    ])

    const u = await readPiUsage('s1', cwd, root)
    expect(u.exists).toBe(true)
    expect(u.turns).toBe(2)
    // reasoning tokens are billed as output
    expect(u.tokens).toEqual({ input: 110, output: 75, cacheCreation: 200, cacheRead: 300 })
    expect(u.costUsd).toBeCloseTo(0.06, 4)
    expect(u.model).toBe('claude-sonnet-5')
  })

  it('sums usage across MULTIPLE jsonl files (one per pi launch) in the dir', async () => {
    writeJsonl('launch1.jsonl', [assistantEntry({ input: 10, output: 5, costTotal: 0.01 })])
    // Second file for the same session dir (a resume/relaunch of the same cwd).
    const dir = piSessionDirFor(cwd, root)
    writeFileSync(
      join(dir, 'launch2.jsonl'),
      assistantEntry({ input: 20, output: 15, costTotal: 0.02 }),
    )

    const u = await readPiUsage('s1', cwd, root)
    expect(u.turns).toBe(2)
    expect(u.tokens.input).toBe(30)
    expect(u.tokens.output).toBe(20)
    expect(u.costUsd).toBeCloseTo(0.03, 4)
  })

  it('ignores non-assistant message entries (e.g. user turns)', async () => {
    writeJsonl('run1.jsonl', [
      JSON.stringify({ message: { role: 'user', content: [] } }),
      assistantEntry({ input: 5, output: 5 }),
    ])
    const u = await readPiUsage('s1', cwd, root)
    expect(u.turns).toBe(1)
    expect(u.tokens.input).toBe(5)
  })

  it('tolerates partial/garbage lines without throwing', async () => {
    writeJsonl('run1.jsonl', [
      '{ not json',
      '',
      assistantEntry({ input: 7, output: 3 }),
      JSON.stringify({ message: { role: 'assistant' /* no usage */ } }),
    ])
    const u = await readPiUsage('s1', cwd, root)
    expect(u.turns).toBe(1)
    expect(u.tokens.input).toBe(7)
  })

  it('is lenient when model is absent', async () => {
    writeJsonl('run1.jsonl', [
      JSON.stringify({
        message: {
          role: 'assistant',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ])
    const u = await readPiUsage('s1', cwd, root)
    expect(u.turns).toBe(1)
    expect(u.model).toBeUndefined()
  })
})
