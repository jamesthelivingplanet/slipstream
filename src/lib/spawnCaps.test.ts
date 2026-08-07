import { describe, it, expect } from 'vitest'
import {
  sessionDepth,
  buildDepthIndex,
  isAtDepthLimit,
  isAtFanoutLimit,
  spawnedLabel,
} from './spawnCaps.js'
import type { Session } from './types.js'

// Minimal Session stub — only `id`/`parentId` matter to these helpers.
function stub(id: string, parentId?: string): Session {
  return {
    id,
    parentId,
    tid: id,
    src: 'jira',
    status: 'running',
    title: id,
    repo: null,
    branch: null,
    add: 0,
    del: 0,
    behind: 0,
    ago: '',
    activity: { text: '' },
  } as Session
}

// ─── sessionDepth ───────────────────────────────────────────────────────────

describe('sessionDepth', () => {
  it('is 0 for a session with no parentId', () => {
    const sessions = [stub('a')]
    expect(sessionDepth(sessions, 'a')).toBe(0)
  })

  it('is 0 for an undefined sessionId', () => {
    expect(sessionDepth([stub('a')], undefined)).toBe(0)
  })

  it('is 0 for a sessionId not present in the list', () => {
    expect(sessionDepth([stub('a')], 'missing')).toBe(0)
  })

  it('is 1 for a direct child', () => {
    const sessions = [stub('root'), stub('child', 'root')]
    expect(sessionDepth(sessions, 'child')).toBe(1)
  })

  it('walks multiple generations', () => {
    const sessions = [
      stub('root'),
      stub('gen1', 'root'),
      stub('gen2', 'gen1'),
      stub('gen3', 'gen2'),
    ]
    expect(sessionDepth(sessions, 'gen3')).toBe(3)
  })

  it('counts one hop even when the parentId points to an unknown session', () => {
    // 'orphan' claims a parent that isn't in the list. The walk still counts
    // that one hop (mirroring agentSpawnService.ts's depthOf) before the
    // next iteration finds no `current` to continue from.
    const sessions = [stub('orphan', 'ghost')]
    expect(sessionDepth(sessions, 'orphan')).toBe(1)
  })

  it('terminates on a parentId cycle instead of hanging', () => {
    // a -> b -> a: a corrupted/cyclic chain. The visited-set guard must
    // break the loop rather than spinning forever or hitting MAX_DEPTH_WALK.
    const sessions = [stub('a', 'b'), stub('b', 'a')]
    const depth = sessionDepth(sessions, 'a')
    expect(depth).toBeGreaterThanOrEqual(0)
    expect(depth).toBeLessThan(64)
  })

  it('self-referencing parentId terminates immediately', () => {
    const sessions = [stub('a', 'a')]
    expect(sessionDepth(sessions, 'a')).toBe(0)
  })
})

// ─── buildDepthIndex ────────────────────────────────────────────────────────

describe('buildDepthIndex', () => {
  it('returns an empty Map for an empty session list', () => {
    const index = buildDepthIndex([])
    expect(index.size).toBe(0)
  })

  it('is 0 for a root session with no parentId', () => {
    const sessions = [stub('a')]
    const index = buildDepthIndex(sessions)
    expect(index.get('a')).toBe(0)
  })

  it('computes correct depths across a multi-level tree', () => {
    const sessions = [
      stub('root'),
      stub('gen1', 'root'),
      stub('gen2', 'gen1'),
      stub('gen3', 'gen2'),
    ]
    const index = buildDepthIndex(sessions)
    expect(index.get('root')).toBe(0)
    expect(index.get('gen1')).toBe(1)
    expect(index.get('gen2')).toBe(2)
    expect(index.get('gen3')).toBe(3)
  })

  it('counts one hop for an orphan whose parentId is not in the list', () => {
    // Mirrors sessionDepth's own orphan semantics: the one hop to the
    // unknown parent still counts before the walk has nowhere left to go.
    const sessions = [stub('orphan', 'ghost')]
    const index = buildDepthIndex(sessions)
    expect(index.get('orphan')).toBe(1)
  })

  it('terminates on a parentId cycle instead of hanging', () => {
    // a -> b -> a: the visited-set guard (plus MAX_DEPTH_WALK bound) must
    // break each walk rather than spinning forever.
    const sessions = [stub('a', 'b'), stub('b', 'a')]
    const index = buildDepthIndex(sessions)
    expect(index.size).toBe(2)
    for (const id of ['a', 'b']) {
      const depth = index.get(id)
      expect(typeof depth).toBe('number')
      expect(depth).toBeGreaterThanOrEqual(0)
      expect(depth).toBeLessThan(64)
    }
  })
})

// ─── isAtDepthLimit ─────────────────────────────────────────────────────────

describe('isAtDepthLimit', () => {
  it('is false when maxDepth is 0 (unlimited), regardless of depth', () => {
    expect(isAtDepthLimit(0, 0)).toBe(false)
    expect(isAtDepthLimit(50, 0)).toBe(false)
  })

  it('is false when depth is under maxDepth', () => {
    expect(isAtDepthLimit(2, 3)).toBe(false)
  })

  it('is true at the exact boundary (depth === maxDepth)', () => {
    expect(isAtDepthLimit(3, 3)).toBe(true)
  })

  it('is true when depth exceeds maxDepth', () => {
    expect(isAtDepthLimit(5, 3)).toBe(true)
  })
})

// ─── isAtFanoutLimit ────────────────────────────────────────────────────────

describe('isAtFanoutLimit', () => {
  it('is false when maxChildrenPerSession is 0 (unlimited), regardless of count', () => {
    expect(isAtFanoutLimit(0, 0)).toBe(false)
    expect(isAtFanoutLimit(100, 0)).toBe(false)
  })

  it('is false when count is under the cap', () => {
    expect(isAtFanoutLimit(9, 10)).toBe(false)
  })

  it('is true at the exact boundary (count === max)', () => {
    expect(isAtFanoutLimit(10, 10)).toBe(true)
  })

  it('is true when count exceeds the cap', () => {
    expect(isAtFanoutLimit(12, 10)).toBe(true)
  })
})

// ─── spawnedLabel ───────────────────────────────────────────────────────────

describe('spawnedLabel', () => {
  it('renders plain "N spawned" when unlimited (max === 0)', () => {
    expect(spawnedLabel(4, 0)).toBe('4 spawned')
  })

  it('renders "N/max spawned" when the cap is enforced', () => {
    expect(spawnedLabel(4, 10)).toBe('4/10 spawned')
  })

  it('renders the boundary correctly when at the cap', () => {
    expect(spawnedLabel(10, 10)).toBe('10/10 spawned')
  })
})
