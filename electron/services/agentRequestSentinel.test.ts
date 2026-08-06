import { describe, it, expect } from 'vitest'
import {
  parseAgentRequests,
  parseAgentResponses,
  AGENT_REQUESTS_FILE,
  AGENT_RESPONSES_FILE,
} from './agentRequestSentinel.js'

describe('agentRequestSentinel — constants', () => {
  it('exports the expected file names', () => {
    expect(AGENT_REQUESTS_FILE).toBe('requests.ndjson')
    expect(AGENT_RESPONSES_FILE).toBe('responses.ndjson')
  })
})

describe('parseAgentRequests', () => {
  it('parses a valid multi-line file covering all three request kinds', () => {
    const ts = Date.now()
    const raw =
      JSON.stringify({
        id: 'r1',
        kind: 'new-agent',
        ts,
        repo: 'acme/api',
        title: 'Fix the thing',
        prompt: 'do it',
        agent: 'claude-code',
      }) +
      '\n' +
      JSON.stringify({ id: 'r2', kind: 'repos', ts: ts + 1 }) +
      '\n' +
      JSON.stringify({ id: 'r3', kind: 'agents', ts: ts + 2 }) +
      '\n'

    const parsed = parseAgentRequests(raw)
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({
      id: 'r1',
      kind: 'new-agent',
      ts,
      repo: 'acme/api',
      title: 'Fix the thing',
      prompt: 'do it',
      agent: 'claude-code',
    })
    expect(parsed[1]).toEqual({ id: 'r2', kind: 'repos', ts: ts + 1 })
    expect(parsed[2]).toEqual({ id: 'r3', kind: 'agents', ts: ts + 2 })
  })

  it('parses a new-agent request without the optional agent field', () => {
    const ts = Date.now()
    const raw = JSON.stringify({
      id: 'r1',
      kind: 'new-agent',
      ts,
      repo: 'acme/api',
      title: 'Fix the thing',
      prompt: 'do it',
    })
    const parsed = parseAgentRequests(raw)
    expect(parsed).toEqual([
      {
        id: 'r1',
        kind: 'new-agent',
        ts,
        repo: 'acme/api',
        title: 'Fix the thing',
        prompt: 'do it',
      },
    ])
  })

  it('returns [] for an empty string', () => {
    expect(parseAgentRequests('')).toEqual([])
  })

  it('skips malformed lines without losing well-formed ones', () => {
    const ts = Date.now()
    const raw =
      'not json\n' +
      JSON.stringify({ id: 'r1', kind: 'repos', ts }) +
      '\n' +
      JSON.stringify({ id: 'r2' }) + // missing kind/ts
      '\n' +
      JSON.stringify({ id: 'r3', kind: 'bogus', ts }) + // invalid kind
      '\n' +
      JSON.stringify({ kind: 'repos', ts }) // missing id
    const parsed = parseAgentRequests(raw)
    expect(parsed).toEqual([{ id: 'r1', kind: 'repos', ts }])
  })

  it('skips a new-agent line missing required fields', () => {
    const ts = Date.now()
    const raw = JSON.stringify({ id: 'r1', kind: 'new-agent', ts, title: 'x', prompt: 'y' }) // no repo
    expect(parseAgentRequests(raw)).toEqual([])
  })

  it('skips a partial trailing line cut off mid-JSON (no final newline)', () => {
    const ts = Date.now()
    const raw =
      JSON.stringify({ id: 'r1', kind: 'agents', ts }) +
      '\n' +
      '{"id":"r2","kind":"repos","ts":' +
      String(ts + 1) // truncated, no closing brace
    const parsed = parseAgentRequests(raw)
    expect(parsed).toEqual([{ id: 'r1', kind: 'agents', ts }])
  })

  describe('kind agents — all/tid pass-through', () => {
    it('passes through `all: true`', () => {
      const ts = Date.now()
      const raw = JSON.stringify({ id: 'r1', kind: 'agents', ts, all: true })
      expect(parseAgentRequests(raw)).toEqual([{ id: 'r1', kind: 'agents', ts, all: true }])
    })

    it('passes through `tid`', () => {
      const ts = Date.now()
      const raw = JSON.stringify({ id: 'r1', kind: 'agents', ts, tid: 'TASK-ABCDE' })
      expect(parseAgentRequests(raw)).toEqual([{ id: 'r1', kind: 'agents', ts, tid: 'TASK-ABCDE' }])
    })

    it('carries neither field when both are absent', () => {
      const ts = Date.now()
      const raw = JSON.stringify({ id: 'r1', kind: 'agents', ts })
      expect(parseAgentRequests(raw)).toEqual([{ id: 'r1', kind: 'agents', ts }])
    })

    it('ignores a non-boolean `all`', () => {
      const ts = Date.now()
      const raw = JSON.stringify({ id: 'r1', kind: 'agents', ts, all: 'yes' })
      expect(parseAgentRequests(raw)).toEqual([{ id: 'r1', kind: 'agents', ts }])
    })

    it('ignores an empty-string `tid`', () => {
      const ts = Date.now()
      const raw = JSON.stringify({ id: 'r1', kind: 'agents', ts, tid: '' })
      expect(parseAgentRequests(raw)).toEqual([{ id: 'r1', kind: 'agents', ts }])
    })
  })
})

describe('parseAgentResponses', () => {
  it('parses ok:true and ok:false lines', () => {
    const ts = Date.now()
    const raw =
      JSON.stringify({ id: 'r1', ok: true, ts, data: { sessionId: 's1' } }) +
      '\n' +
      JSON.stringify({ id: 'r2', ok: false, ts: ts + 1, error: 'Unknown repo: nope' }) +
      '\n'
    const parsed = parseAgentResponses(raw)
    expect(parsed).toEqual([
      { id: 'r1', ok: true, ts, data: { sessionId: 's1' } },
      { id: 'r2', ok: false, ts: ts + 1, error: 'Unknown repo: nope' },
    ])
  })

  it('parses an ok:true response with no data', () => {
    const ts = Date.now()
    const raw = JSON.stringify({ id: 'r1', ok: true, ts })
    expect(parseAgentResponses(raw)).toEqual([{ id: 'r1', ok: true, ts, data: undefined }])
  })

  it('returns [] for an empty string', () => {
    expect(parseAgentResponses('')).toEqual([])
  })

  it('skips malformed lines without losing well-formed ones', () => {
    const ts = Date.now()
    const raw =
      'not json\n' +
      JSON.stringify({ id: 'r1', ok: true, ts, data: 1 }) +
      '\n' +
      JSON.stringify({ id: 'r2', ok: false, ts }) + // missing error
      '\n' +
      JSON.stringify({ ok: true, ts }) // missing id
    const parsed = parseAgentResponses(raw)
    expect(parsed).toEqual([{ id: 'r1', ok: true, ts, data: 1 }])
  })

  it('skips a partial trailing line cut off mid-JSON (no final newline)', () => {
    const ts = Date.now()
    const raw =
      JSON.stringify({ id: 'r1', ok: true, ts }) +
      '\n' +
      '{"id":"r2","ok":false,"ts":' +
      String(ts + 1) +
      ',"error":"boo' // truncated
    const parsed = parseAgentResponses(raw)
    expect(parsed).toEqual([{ id: 'r1', ok: true, ts, data: undefined }])
  })
})
