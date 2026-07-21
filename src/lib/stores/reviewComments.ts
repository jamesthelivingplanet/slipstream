import { writable } from 'svelte/store'
import type { ReviewComment } from '../review.js'

/** Draft review comments accumulated in the Diff view, keyed by session id, so
 *  they survive tab toggles and the `{#key $selected.id}` remount. In-memory
 *  only (lost on reload). Svelte 4 reactivity needs reassignment, so every
 *  action below replaces the record/array instances rather than mutating. */
export const reviewComments = writable<Record<string, ReviewComment[]>>({})

/** Append a review comment for the given session. */
export function addReviewComment(sessionId: string, c: ReviewComment): void {
  reviewComments.update(($r) => ({
    ...$r,
    [sessionId]: [...($r[sessionId] ?? []), c],
  }))
}

/** Remove a single review comment (by id) for the given session. No-op if the
 *  session has no draft comments (avoids creating a stray empty array entry). */
export function removeReviewComment(sessionId: string, commentId: string): void {
  reviewComments.update(($r) => {
    const existing = $r[sessionId]
    if (!existing) return $r
    return { ...$r, [sessionId]: existing.filter((c) => c.id !== commentId) }
  })
}

/** Discard all draft review comments for the given session (e.g. after a
 *  successful submit, or via the Discard-all confirm). */
export function clearReviewComments(sessionId: string): void {
  reviewComments.update(($r) => {
    const next = { ...$r }
    delete next[sessionId]
    return next
  })
}
