/**
 * Spawn-cap helpers — pure functions backing Mission Control's spawn-safety
 * UI. Mirrors the depth/fan-out semantics of `SpawnPolicy`
 * (electron/shared/contract.ts) and the enforcement in
 * `electron/services/agentSpawnService.ts`: when an agent's `slipstream
 * new-agent` request would exceed a cap, the daemon answers ok:false and the
 * agent sees the error in its OWN terminal — Mission Control otherwise shows
 * nothing, so a spawn tree silently stops growing with no visible reason.
 * These helpers compute, client-side, whether a session is at (or near) a
 * cap so the UI can surface that state instead of staying silent.
 *
 * Both caps use the repo-wide `0 = unlimited` convention.
 */
import type { Session } from './types.js'

/** Bounds the parentId-chain walk in `sessionDepth` below. Mirrors
 *  agentSpawnService.ts's own MAX_DEPTH_WALK — a real spawn tree never gets
 *  remotely this deep (the default maxDepth is 3), so this exists purely as
 *  a second, independent guard alongside the `visited` set: even a
 *  corrupted/cyclic parentId chain in the sessions store can't hang the
 *  renderer in an infinite loop. */
const MAX_DEPTH_WALK = 64

/**
 * Depth of `sessionId` within its spawn tree, computed by walking
 * `parentId` through the known `sessions` list: a session with no
 * `parentId` is depth 0, and each hop to a parent adds 1.
 *
 * Cycle-safe two ways: a `visited` set stops the walk the moment it would
 * revisit a session already seen (breaking any cycle immediately), and the
 * loop is separately bounded by `MAX_DEPTH_WALK` as a belt-and-suspenders
 * guard. Either alone would terminate the walk; both together mean a
 * corrupted `parentId` graph can never hang the tab.
 */
export function sessionDepth(sessions: Session[], sessionId: string | undefined): number {
  if (!sessionId) return 0
  const byId = new Map<string, Session>()
  for (const s of sessions) if (s.id) byId.set(s.id, s)

  let depth = 0
  let current = byId.get(sessionId)
  const visited = new Set<string>([sessionId])
  while (current?.parentId && depth < MAX_DEPTH_WALK) {
    if (visited.has(current.parentId)) break // cycle — stop instead of looping forever
    visited.add(current.parentId)
    current = byId.get(current.parentId)
    depth += 1
  }
  return depth
}

/**
 * Depth of every session in `sessions`, computed in a single pass — the
 * batch counterpart to `sessionDepth` above.
 *
 * Why this exists: session `status` events fire on every PTY chunk, not just
 * on a real state change (see the repo's "status flaps by design" note), so
 * Mission Control's `$sessions` store updates continuously — even on an
 * idle screen. `sessionDepth` rebuilds an id→session `Map` from scratch on
 * every call; calling it once per row across N rows made a render pass
 * O(n^2) in session count, and that quadratic work re-ran on every flap.
 * `buildDepthIndex` builds the id→session `Map` exactly once for the whole
 * session list, then walks each session's `parentId` chain, memoizing
 * depths as it goes so a walk can stop early the moment it reaches a
 * session whose depth is already known — O(n) total instead of O(n) per row.
 *
 * Cycle-safe the same way `sessionDepth` is: each walk is bounded by
 * `MAX_DEPTH_WALK` and tracked with a per-walk `visited` set, so a
 * corrupted/cyclic `parentId` graph can never hang the tab.
 */
export function buildDepthIndex(sessions: Session[]): Map<string, number> {
  const byId = new Map<string, Session>()
  for (const s of sessions) if (s.id) byId.set(s.id, s)

  const depths = new Map<string, number>()

  for (const s of sessions) {
    if (!s.id || depths.has(s.id)) continue

    // Walk from `s` toward the root — same loop as `sessionDepth`, but
    // reusing the `byId` map built once above instead of rebuilding it,
    // and recording the chain of ancestor ids visited along the way.
    let depth = 0
    let current: Session | undefined = s
    const visited = new Set<string>([s.id])
    const chain: string[] = [] // ancestor ids, nearest first

    while (current?.parentId && depth < MAX_DEPTH_WALK) {
      if (visited.has(current.parentId)) break // cycle — stop instead of looping forever
      visited.add(current.parentId)
      chain.push(current.parentId)
      current = byId.get(current.parentId)
      depth += 1
    }

    depths.set(s.id, depth)

    // Memoize every ancestor visited on this walk too: the depth of the
    // i-th ancestor (0-indexed, nearest first) is `depth - (i + 1)`, since
    // each hop back toward `s` adds exactly one to the depth. This lets a
    // later session in the same chain resolve via the `depths.has` skip
    // above instead of re-walking edges this walk already covered.
    for (let i = 0; i < chain.length; i++) {
      if (!depths.has(chain[i])) depths.set(chain[i], depth - (i + 1))
    }
  }

  return depths
}

/** True when `maxDepth` is enforced (>0) and `depth` has reached or passed
 *  it — the session can no longer spawn a child without the daemon refusing
 *  the `slipstream new-agent` request. `maxDepth === 0` means unlimited, so
 *  this is always false in that case. */
export function isAtDepthLimit(depth: number, maxDepth: number): boolean {
  return maxDepth > 0 && depth >= maxDepth
}

/** True when `maxChildrenPerSession` is enforced (>0) and `count` has
 *  reached or passed it — any further `slipstream new-agent` request from
 *  this session gets answered ok:false. `maxChildrenPerSession === 0` means
 *  unlimited, so this is always false in that case. */
export function isAtFanoutLimit(count: number, maxChildrenPerSession: number): boolean {
  return maxChildrenPerSession > 0 && count >= maxChildrenPerSession
}

/** Text for the "spawned" chip: "N/max spawned" once the fan-out cap is
 *  enforced (`maxChildrenPerSession > 0`), otherwise today's plain "N
 *  spawned" — used both for the true-unlimited case and as the fallback
 *  when no policy is available yet. */
export function spawnedLabel(count: number, maxChildrenPerSession: number): string {
  if (maxChildrenPerSession > 0) return `${count}/${maxChildrenPerSession} spawned`
  return `${count} spawned`
}
