import { describe, it, expect } from 'vitest'
import { parseAgentEvents, eventsAfter, AGENT_EVENTS_FILE } from './agentEventsSentinel.js'

describe('AGENT_EVENTS_FILE', () => {
  it('is events.ndjson', () => {
    expect(AGENT_EVENTS_FILE).toBe('events.ndjson')
  })
})

describe('parseAgentEvents', () => {
  it('parses one event per NDJSON line', () => {
    const raw =
      JSON.stringify({ kind: 'checkpoint', message: 'tests green', ts: 1 }) +
      '\n' +
      JSON.stringify({ kind: 'approval', message: 'deploy?', ts: 2 }) +
      '\n'
    expect(parseAgentEvents(raw)).toEqual([
      { kind: 'checkpoint', message: 'tests green', ts: 1 },
      { kind: 'approval', message: 'deploy?', ts: 2 },
    ])
  })

  it('keeps the artifact path', () => {
    const raw = JSON.stringify({ kind: 'artifact', message: 'Report', path: '/a/b.md', ts: 3 })
    expect(parseAgentEvents(raw)).toEqual([
      { kind: 'artifact', message: 'Report', path: '/a/b.md', ts: 3 },
    ])
  })

  it('skips blank lines and a partially-written trailing line', () => {
    const raw = JSON.stringify({ kind: 'checkpoint', message: 'a', ts: 1 }) + '\n\n{"kind":"checkpo'
    expect(parseAgentEvents(raw)).toHaveLength(1)
  })

  it.each([
    ['unknown kind', JSON.stringify({ kind: 'bogus', ts: 1 })],
    ['missing ts', JSON.stringify({ kind: 'checkpoint' })],
    ['non-numeric ts', JSON.stringify({ kind: 'checkpoint', ts: 'now' })],
    ['not an object', JSON.stringify('checkpoint')],
    ['malformed json', '{nope'],
  ])('drops a line with %s', (_name, line) => {
    expect(parseAgentEvents(line)).toEqual([])
  })

  it('drops non-string message/path instead of failing the line', () => {
    const raw = JSON.stringify({ kind: 'checkpoint', message: 42, path: 7, ts: 1 })
    expect(parseAgentEvents(raw)).toEqual([{ kind: 'checkpoint', ts: 1 }])
  })
})

describe('eventsAfter', () => {
  const raw =
    JSON.stringify({ kind: 'checkpoint', message: 'a', ts: 10 }) +
    '\n' +
    JSON.stringify({ kind: 'checkpoint', message: 'b', ts: 20 }) +
    '\n' +
    JSON.stringify({ kind: 'approval', message: 'c', ts: 30 }) +
    '\n'

  it('returns only events strictly newer than the cursor, stamped with the session id', () => {
    expect(eventsAfter(raw, 20, 's1')).toEqual([
      { sessionId: 's1', kind: 'approval', message: 'c', ts: 30 },
    ])
  })

  it('cursor 0 replays the whole history (restart replay is intentional)', () => {
    expect(eventsAfter(raw, 0, 's1')).toHaveLength(3)
  })

  it('returns [] when nothing is newer', () => {
    expect(eventsAfter(raw, 30, 's1')).toEqual([])
  })
})
