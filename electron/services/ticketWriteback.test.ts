import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTicketWriteback } from './ticketWriteback.js'
import type {
  ISessionManager,
  ISessionStore,
  ITicketProvider,
  SessionDTO,
} from '../shared/contract.js'

function makeSession(overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 's1',
    tid: 'FLO-1',
    title: 'Fix bug',
    prompt: 'fix it',
    repoId: 'r1',
    branch: 'flo-1-fix-bug',
    status: 'running',
    createdAt: Date.now(),
    agentKind: 'claude-code',
    src: 'linear',
    ...overrides,
  }
}

function makeFakes() {
  const emitter = new EventEmitter()
  const sessions = {
    on: (e: string, l: (...a: unknown[]) => void) => {
      emitter.on(e, l)
    },
    off: (e: string, l: (...a: unknown[]) => void) => {
      emitter.removeListener(e, l)
    },
  } as unknown as Pick<ISessionManager, 'on' | 'off'>

  const map = new Map<string, SessionDTO>()
  const store: ISessionStore = {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    upsert: (s) => {
      map.set(s.id, s)
    },
    delete: (id) => {
      map.delete(id)
    },
  }

  const postComment = vi.fn().mockResolvedValue(true)
  const tickets = { postComment } as unknown as ITicketProvider

  return { emitter, sessions, store, map, tickets, postComment }
}

// The pr handler kicks off an async postComment; let the microtask queue drain.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createTicketWriteback', () => {
  it('posts exactly one comment with the tid, src, and PR url', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())
    createTicketWriteback({ sessions, store, tickets })

    emitter.emit('pr', 's1', 'https://gitlab.com/acme/api/-/merge_requests/7')
    await flush()

    expect(postComment).toHaveBeenCalledTimes(1)
    const [tid, body, src] = postComment.mock.calls[0]
    expect(tid).toBe('FLO-1')
    expect(src).toBe('linear')
    expect(body).toContain('FLO-1')
    expect(body).toContain('`flo-1-fix-bug`')
    expect(body).toContain('https://gitlab.com/acme/api/-/merge_requests/7')
  })

  it('skips sessions that are not persisted', async () => {
    const { emitter, sessions, store, tickets, postComment } = makeFakes()
    createTicketWriteback({ sessions, store, tickets })

    emitter.emit('pr', 'ghost', 'https://example.com/pr/1')
    await flush()

    expect(postComment).not.toHaveBeenCalled()
  })

  it('skips sessions with no ticket source (blank/TASK-draft agents)', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession({ src: undefined }))
    createTicketWriteback({ sessions, store, tickets })

    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    await flush()

    expect(postComment).not.toHaveBeenCalled()
  })

  it('skips when the persisted prUrl already equals the url (restart dedupe)', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession({ prUrl: 'https://example.com/pr/1' }))
    createTicketWriteback({ sessions, store, tickets })

    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    await flush()

    expect(postComment).not.toHaveBeenCalled()
  })

  it('posts once for a burst of duplicate pr events (in-memory dedupe)', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())
    createTicketWriteback({ sessions, store, tickets })

    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    await flush()

    expect(postComment).toHaveBeenCalledTimes(1)
  })

  it('a throwing provider never propagates (session unaffected)', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())
    postComment.mockRejectedValue(new Error('linear down'))
    createTicketWriteback({ sessions, store, tickets })

    expect(() => emitter.emit('pr', 's1', 'https://example.com/pr/1')).not.toThrow()
    await flush()

    expect(postComment).toHaveBeenCalledTimes(1)
  })

  it('logs via the RunLogger when the provider throws', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())
    postComment.mockRejectedValue(new Error('linear down'))
    const server = vi.fn()
    createTicketWriteback({
      sessions,
      store,
      tickets,
      logger: { spawn: vi.fn(), exit: vi.fn(), server },
    })

    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    await flush()

    expect(server).toHaveBeenCalledWith('warn', expect.stringContaining('FLO-1'), expect.anything())
  })

  it('dispose() unsubscribes from pr events', async () => {
    const { emitter, sessions, store, map, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())
    const wb = createTicketWriteback({ sessions, store, tickets })

    wb.dispose()
    emitter.emit('pr', 's1', 'https://example.com/pr/1')
    await flush()

    expect(postComment).not.toHaveBeenCalled()
  })
})
