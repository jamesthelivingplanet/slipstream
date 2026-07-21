/**
 * manage-tokens — admin CLI for the per-device/per-user token store (FLO-143).
 * Not agent-facing (unlike ./slipstream.ts): an operator runs this against the
 * daemon's own DB to onboard or revoke a device/user credential.
 *
 * Usage (after `pnpm build`):
 *   ELECTRON_RUN_AS_NODE=1 electron dist-electron/manage-tokens.js issue <ownerId> <label>
 *   ELECTRON_RUN_AS_NODE=1 electron dist-electron/manage-tokens.js list
 *   ELECTRON_RUN_AS_NODE=1 electron dist-electron/manage-tokens.js revoke <id>
 *
 * `issue` prints the plaintext token exactly once (it is never persisted or
 * retrievable again) — hand it to the new device as its SLIPSTREAM_TOKEN.
 *
 * runManageTokens is pure (deps injected) so it's unit-testable without a DB;
 * main() below wires the real store and is the only part that isn't.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IDeviceTokenStore } from '../services/deviceTokenStore.js'

export interface ManageTokensDeps {
  store: IDeviceTokenStore
  log: (msg: string) => void
}

/** Dispatch one command. Returns the process exit code. */
export function runManageTokens(argv: string[], deps: ManageTokensDeps): number {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'issue': {
      const [ownerId, ...labelParts] = rest
      const label = labelParts.join(' ')
      if (!ownerId || !label) {
        deps.log('Usage: manage-tokens issue <ownerId> <label>')
        return 1
      }
      const { token, dto } = deps.store.issue(ownerId, label)
      deps.log(JSON.stringify({ ...dto, token }, null, 2))
      return 0
    }
    case 'list': {
      deps.log(JSON.stringify(deps.store.list(), null, 2))
      return 0
    }
    case 'revoke': {
      const [id] = rest
      if (!id) {
        deps.log('Usage: manage-tokens revoke <id>')
        return 1
      }
      deps.store.revoke(id)
      deps.log(`Revoked ${id}`)
      return 0
    }
    default:
      deps.log('Usage: manage-tokens <issue <ownerId> <label> | list | revoke <id>>')
      return 1
  }
}

// ── Entry point (run under ELECTRON_RUN_AS_NODE=1 electron) ──────────────────

// Only bootstrap when run as a script, not when imported by tests. Lazy-import
// the DB/services layer only here so importing runManageTokens for tests never
// loads better-sqlite3 (built for Electron's ABI, can't load under Node vitest
// — see docs/NATIVE-MODULES.md).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { openDb } = await import('../db/db.js')
  const { createDeviceTokenStore } = await import('../services/deviceTokenStore.js')
  const { resolveDataDir } = await import('../core/services.js')

  const dataDir = resolveDataDir()
  const db = openDb(path.join(dataDir, 'slipstream.db'))
  const store = createDeviceTokenStore(db)

  const code = runManageTokens(process.argv.slice(2), { store, log: console.log })
  process.exit(code)
}
