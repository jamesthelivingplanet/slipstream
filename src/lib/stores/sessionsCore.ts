import { writable } from 'svelte/store'
import type { Session } from '../types'

/**
 * The raw sessions writable, split into its own leaf module so it has no
 * dependencies of its own. `ui.ts` (derived selected/counts/visible) and
 * `repos.ts` (removeRepoById's live-session guard) both need to read it
 * without depending on the full session-actions module in `sessions.ts`
 * (which itself depends on `ui.ts` and `repos.ts`) — routing everyone through
 * this leaf avoids a module-init cycle. `sessions.ts` re-exports this store
 * under the same name, so `../stores` and other consumers never see the seam.
 */
export const sessions = writable<Session[]>([])
