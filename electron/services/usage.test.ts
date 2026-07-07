import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscriptUsage, buildUsageSummary, familyForModel } from './usage.js'
import type { SessionDTO } from '../shared/contract.js'

let projectsDir: string

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'slipstream-usage-'))
})

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true })
})

/** Write a transcript <id>.jsonl under <projectsDir>/<sub> with the given lines. */
function writeTranscript(sub: string, id: string, lines: string[]): void {
  mkdirSync(join(projectsDir, sub), { recursive: true })
  writeFileSync(join(projectsDir, sub, `${id}.jsonl`), lines.join('\n'))
}

/** A full assistant turn JSONL line carrying per-turn usage + model. */
function assistantTurn(opts: {
  id?: string
  model?: string
  input?: number
  output?: number
  cacheCreation?: number
  cacheRead?: number
}): string {
  const id = opts.id ?? crypto.randomUUID()
  const model = opts.model ?? 'claude-sonnet-5'
  return JSON.stringify({
    parentUuid: null,
    type: 'assistant',
    uuid: id,
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  })
}

const NON_USAGE_LINES = [
  JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: 's' }),
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's' }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hi' },
    // deliberately no usage — user turns carry none
  }),
]

// ─── familyForModel ─────────────────────────────────────────────────────────

describe('familyForModel', () => {
  it('maps opus/sonnet/haiku aliases by substring', () => {
    expect(familyForModel('claude-opus-4-8')).toBe('opus')
    expect(familyForModel('claude-sonnet-4-6')).toBe('sonnet')
    expect(familyForModel('sonnet')).toBe('sonnet')
    expect(familyForModel('claude-3-5-haiku')).toBe('haiku')
  })

  it('defaults unknowns (incl. <synthetic>) to sonnet', () => {
    expect(familyForModel('<synthetic>')).toBe('sonnet')
    expect(familyForModel(undefined)).toBe('sonnet')
    expect(familyForModel('some-future-model')).toBe('sonnet')
  })
})

// ─── readTranscriptUsage ────────────────────────────────────────────────────

describe('readTranscriptUsage', () => {
  it('returns exists:false with zero tokens when no transcript is present', () => {
    const u = readTranscriptUsage('missing-id', projectsDir)
    expect(u.exists).toBe(false)
    expect(u.turns).toBe(0)
    expect(u.costUsd).toBe(0)
    expect(u.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 })
  })

  it('sums usage across assistant turns (ignoring non-usage lines)', () => {
    const id = 'sess-a'
    writeTranscript('proj-a', id, [
      ...NON_USAGE_LINES,
      assistantTurn({
        input: 100,
        output: 50,
        cacheCreation: 200,
        cacheRead: 300,
      }),
      assistantTurn({
        input: 10,
        output: 5,
        cacheCreation: 20,
        cacheRead: 30,
      }),
    ])

    const u = readTranscriptUsage(id, projectsDir)
    expect(u.exists).toBe(true)
    expect(u.turns).toBe(2)
    expect(u.tokens).toEqual({
      input: 110,
      output: 55,
      cacheCreation: 220,
      cacheRead: 330,
    })
    expect(u.model).toBe('claude-sonnet-5')
  })

  it('estimates cost from the per-turn model (sonnet rates)', () => {
    const id = 'sess-cost'
    writeTranscript('proj-a', id, [
      assistantTurn({
        model: 'claude-sonnet-5',
        input: 1_000_000,
        output: 1_000_000,
      }),
    ])
    // sonnet: $3/M in + $15/M out → 3 + 15 = $18
    const u = readTranscriptUsage(id, projectsDir)
    expect(u.costUsd).toBeCloseTo(18, 4)
  })

  it('uses opus rates for opus models', () => {
    const id = 'sess-opus'
    writeTranscript('proj-a', id, [
      assistantTurn({
        model: 'claude-opus-4-8',
        input: 1_000_000,
        output: 1_000_000,
      }),
    ])
    // opus: $15/M in + $75/M out → 15 + 75 = $90
    const u = readTranscriptUsage(id, projectsDir)
    expect(u.costUsd).toBeCloseTo(90, 4)
  })

  it('charges cache creation at the write rate and cache read at the read rate', () => {
    const id = 'sess-cache'
    writeTranscript('proj-a', id, [
      assistantTurn({
        model: 'sonnet',
        cacheCreation: 1_000_000,
        cacheRead: 1_000_000,
      }),
    ])
    // sonnet cache: $3.75/M write + $0.30/M read → 3.75 + 0.30 = $4.05
    const u = readTranscriptUsage(id, projectsDir)
    expect(u.costUsd).toBeCloseTo(4.05, 4)
  })

  it('tolerates malformed/partial JSONL lines without throwing', () => {
    const id = 'sess-junk'
    writeTranscript('proj-a', id, [
      '{ this is not json',
      '', // blank line
      assistantTurn({ input: 7, output: 3 }),
      JSON.stringify({ type: 'assistant', message: {/* no usage */} }),
    ])
    const u = readTranscriptUsage(id, projectsDir)
    expect(u.turns).toBe(1)
    expect(u.tokens.input).toBe(7)
    expect(u.tokens.output).toBe(3)
  })

  it('keeps the last-seen model when turns use mixed models', () => {
    const id = 'sess-mixed'
    writeTranscript('proj-a', id, [
      assistantTurn({ model: 'claude-opus-4-8', input: 1 }),
      assistantTurn({ model: 'claude-sonnet-5', input: 2 }),
    ])
    const u = readTranscriptUsage(id, projectsDir)
    expect(u.model).toBe('claude-sonnet-5')
  })
})

// ─── buildUsageSummary ──────────────────────────────────────────────────────

function dto(id: string, repoId: string, createdAt: number): SessionDTO {
  return {
    id,
    tid: 'TID-1',
    title: 't',
    prompt: 'p',
    repoId,
    branch: 'b',
    status: 'done',
    createdAt,
  }
}

describe('buildUsageSummary', () => {
  it('skips sessions whose transcript does not exist', () => {
    const summary = buildUsageSummary([dto('no-file', 'repo-1', 0)], projectsDir)
    expect(summary.sessions).toHaveLength(0)
    expect(summary.byRepo).toHaveLength(0)
    expect(summary.costUsd).toBe(0)
  })

  it('aggregates tokens + cost by repo and by day', () => {
    // Two sessions in repo-1 (same day), one in repo-2 (another day).
    const day1 = Date.UTC(2026, 6, 1) // 2026-07-01
    const day2 = Date.UTC(2026, 6, 2) // 2026-07-02

    writeTranscript('p1', 's1', [
      assistantTurn({ model: 'sonnet', input: 1_000_000, output: 1_000_000 }), // $18
    ])
    writeTranscript('p1', 's2', [
      assistantTurn({ model: 'sonnet', input: 1_000_000, output: 1_000_000 }), // $18
    ])
    writeTranscript('p2', 's3', [
      assistantTurn({ model: 'opus', input: 1_000_000, output: 1_000_000 }), // $90
    ])

    const summary = buildUsageSummary(
      [dto('s1', 'repo-1', day1), dto('s2', 'repo-1', day1), dto('s3', 'repo-2', day2)],
      projectsDir,
    )

    // totals
    expect(summary.costUsd).toBeCloseTo(126, 4) // 18 + 18 + 90
    expect(summary.total.input).toBe(3_000_000)

    // byRepo: most expensive first → repo-2 ($90) then repo-1 ($36)
    expect(summary.byRepo.map((b) => b.key)).toEqual(['repo-2', 'repo-1'])
    expect(summary.byRepo[0].costUsd).toBeCloseTo(90, 4)
    expect(summary.byRepo[1].costUsd).toBeCloseTo(36, 4)
    expect(summary.byRepo[1].sessions).toBe(2)

    // byDay: most recent first → 2026-07-02 then 2026-07-01
    expect(summary.byDay.map((b) => b.key)).toEqual(['2026-07-02', '2026-07-01'])
    expect(summary.byDay[0].costUsd).toBeCloseTo(90, 4)
    expect(summary.byDay[1].costUsd).toBeCloseTo(36, 4)

    // per-session detail, most expensive first
    expect(summary.sessions.map((s) => s.sessionId)).toEqual(['s3', 's1', 's2'])
  })

  it('skips a transcript that exists but has no usage turns yet', () => {
    writeTranscript('p1', 's-empty', [
      JSON.stringify({ type: 'last-prompt', sessionId: 's-empty' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    ])
    const summary = buildUsageSummary([dto('s-empty', 'repo-1', 0)], projectsDir)
    expect(summary.sessions).toHaveLength(0)
    expect(summary.costUsd).toBe(0)
  })
})
