import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOpencodeUsage } from './opencodeUsage.js'

let storageRoot: string

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'slipstream-oc-usage-'))
})

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true })
})

/** Write a message JSON file at <storageRoot>/message/<sid>/<file>.json */
function writeMessage(sid: string, file: string, content: unknown): void {
  const dir = join(storageRoot, 'message', sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${file}.json`), JSON.stringify(content))
}

/** VERIFIED real assistant message shape (see agentBackend/opencodeUsage docs). */
function assistantMessage(opts: {
  input?: number
  output?: number
  reasoning?: number
  cacheWrite?: number
  cacheRead?: number
  cost?: number
  modelID?: string
}) {
  return {
    role: 'assistant',
    tokens: {
      input: opts.input ?? 0,
      output: opts.output ?? 0,
      reasoning: opts.reasoning ?? 0,
      cache: { read: opts.cacheRead ?? 0, write: opts.cacheWrite ?? 0 },
    },
    cost: opts.cost ?? 0,
    modelID: opts.modelID ?? 'anthropic/claude-sonnet-5',
    sessionID: 'ses_test',
    time: { created: 1, completed: 2 },
  }
}

describe('readOpencodeUsage', () => {
  it('returns exists:false with zero tokens when opencodeSid is undefined', async () => {
    const u = await readOpencodeUsage('s1', undefined, storageRoot)
    expect(u.exists).toBe(false)
    expect(u.turns).toBe(0)
    expect(u.costUsd).toBe(0)
    expect(u.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 })
  })

  it('returns exists:false when the message dir does not exist', async () => {
    const u = await readOpencodeUsage('s1', 'ses_missing', storageRoot)
    expect(u.exists).toBe(false)
  })

  it('returns exists:false for an empty message dir', async () => {
    mkdirSync(join(storageRoot, 'message', 'ses_empty'), { recursive: true })
    const u = await readOpencodeUsage('s1', 'ses_empty', storageRoot)
    expect(u.exists).toBe(true)
    expect(u.turns).toBe(0)
  })

  it('sums input/output/reasoning/cache tokens and cost across assistant messages', async () => {
    const sid = 'ses_abc'
    writeMessage(
      sid,
      'msg1',
      assistantMessage({
        input: 100,
        output: 50,
        reasoning: 20,
        cacheWrite: 200,
        cacheRead: 300,
        cost: 0.05,
        modelID: 'anthropic/claude-sonnet-5',
      }),
    )
    writeMessage(
      sid,
      'msg2',
      assistantMessage({
        input: 10,
        output: 5,
        reasoning: 0,
        cacheWrite: 20,
        cacheRead: 30,
        cost: 0.01,
      }),
    )

    const u = await readOpencodeUsage('s1', sid, storageRoot)
    expect(u.exists).toBe(true)
    expect(u.turns).toBe(2)
    // reasoning tokens are billed as output
    expect(u.tokens).toEqual({ input: 110, output: 75, cacheCreation: 220, cacheRead: 330 })
    expect(u.costUsd).toBeCloseTo(0.06, 4)
    expect(u.model).toBe('anthropic/claude-sonnet-5')
  })

  it('ignores non-assistant messages (e.g. user turns)', async () => {
    const sid = 'ses_user'
    writeMessage(sid, 'msg1', { role: 'user', sessionID: sid })
    writeMessage(sid, 'msg2', assistantMessage({ input: 5, output: 5 }))

    const u = await readOpencodeUsage('s1', sid, storageRoot)
    expect(u.turns).toBe(1)
    expect(u.tokens.input).toBe(5)
  })

  it('skips assistant messages missing a tokens object', async () => {
    const sid = 'ses_notokens'
    writeMessage(sid, 'msg1', { role: 'assistant', sessionID: sid, cost: 1 })
    writeMessage(sid, 'msg2', assistantMessage({ input: 1, output: 1 }))

    const u = await readOpencodeUsage('s1', sid, storageRoot)
    expect(u.turns).toBe(1)
  })

  it('tolerates malformed/unparseable message files without throwing', async () => {
    const sid = 'ses_junk'
    const dir = join(storageRoot, 'message', sid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'garbage.json'), '{ not json')
    writeMessage(sid, 'msg-good', assistantMessage({ input: 7, output: 3 }))

    const u = await readOpencodeUsage('s1', sid, storageRoot)
    expect(u.turns).toBe(1)
    expect(u.tokens.input).toBe(7)
  })

  it('treats missing/non-numeric fields as 0', async () => {
    const sid = 'ses_lenient'
    writeMessage(sid, 'msg1', {
      role: 'assistant',
      sessionID: sid,
      tokens: { input: 'oops', output: null, cache: {} },
      cost: 'free',
    })

    const u = await readOpencodeUsage('s1', sid, storageRoot)
    expect(u.turns).toBe(1)
    expect(u.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 })
    expect(u.costUsd).toBe(0)
  })
})
