import type { Identity } from '../shared/contract.js'

/** The single owner in the local (free) tier. */
export const LOCAL_IDENTITY: Identity = { id: 'local' }

/**
 * Resolve a bearer token to a caller identity. Single-user today: every valid
 * token maps to the local owner. The seam exists so a future multi-user tier
 * can map distinct tokens → distinct identities without a rewrite.
 */
export function resolveIdentity(_token: string): Identity {
  return LOCAL_IDENTITY
}
