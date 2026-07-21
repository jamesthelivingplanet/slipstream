import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wirePrEventListeners } from './wirePrEventListeners.js'
import { createTicketWriteback } from '../services/ticketWriteback.js'
import { createSessionPersistence } from '../services/sessionPersistence.js'
import type {
  IOutcomeStore,
  ISessionManager,
  ISessionStore,
  ITicketProvider,
  SessionDTO,
} from '../shared/contract.js'

/**
 * FLO-136: `wirePrEventListeners` registers `createTicketWriteback` before
 * `createSessionPersistence` — both listen to the session manager's `pr`
 * event, and the write-back's restart-dedupe (`persisted.prUrl === url`)
 * only reads the pre-persistence value if it runs first (Node's
 * EventEmitter invokes listeners in registration order). Neither service's
 * own unit tests exercise the two together, so a reorder used to be
 * invisible to the suite. This test drives the real wiring function, so a
 * reorder of its two calls turns this suite red.
 */

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

  const outcomes: IOutcomeStore = {
    get: () => undefined,
    upsert: () => {},
    list: () => [],
    delete: () => {},
  }

  const postComment = vi.fn().mockResolvedValue(true)
  const tickets = { postComment } as unknown as ITicketProvider

  return { emitter, sessions, store, map, outcomes, tickets, postComment }
}

// The write-back handler kicks off an async postComment; let it drain.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('wirePrEventListeners', () => {
  it('posts the write-back comment on a session pr event (correct registration order)', async () => {
    const { emitter, sessions, store, map, outcomes, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())

    wirePrEventListeners({ sessions, store, tickets, outcomes })

    emitter.emit('pr', 's1', 'https://gitlab.com/acme/api/-/merge_requests/7')
    await flush()

    expect(postComment).toHaveBeenCalledTimes(1)
    expect(store.get('s1')?.prUrl).toBe('https://gitlab.com/acme/api/-/merge_requests/7')
  })
})

describe('registration order (documents the mechanism wirePrEventListeners protects)', () => {
  it('wrong order (persistence before writeback): dedupe swallows the comment', async () => {
    const { emitter, sessions, store, map, outcomes, tickets, postComment } = makeFakes()
    map.set('s1', makeSession())

    // Reversed relative to wirePrEventListeners.ts.
    createSessionPersistence({ sessions, store, outcomes })
    createTicketWriteback({ sessions, store, tickets })

    emitter.emit('pr', 's1', 'https://gitlab.com/acme/api/-/merge_requests/7')
    await flush()

    // Persistence's listener runs first and writes prUrl to the store before
    // the write-back's listener reads it, so the write-back's restart-dedupe
    // check (`persisted.prUrl === url`) is now (incorrectly) true — the
    // comment silently never posts, even though this is the PR's first
    // occurrence, not a restart replay.
    expect(postComment).not.toHaveBeenCalled()
    expect(store.get('s1')?.prUrl).toBe('https://gitlab.com/acme/api/-/merge_requests/7')
  })
})
