// devDataDir.mjs — pure resolution logic for what SLIPSTREAM_DATA_DIR (if
// anything) scripts/dev.mjs should set before spawning the wrapped `pnpm
// dev` / `pnpm dev:backend` command. Extracted out of dev.mjs so the
// decision can be unit tested without touching git, the filesystem, or real
// process.env — see devDataDir.test.mjs. dev.mjs is a thin caller that
// gathers the real inputs (process.env, git worktree detection, the
// on-disk dev-slot registry, process.platform, os.homedir()) and prints the
// result.

import path from 'node:path'
import { DEV_DATA_ROOT, slugForRoot } from './devSlots.mjs'

/**
 * prodDataDirDefault — the platform default that electron/core/services.ts's
 * resolveDataDir() would produce when SLIPSTREAM_DATA_DIR is unset. This
 * duplicates that switch statement rather than importing it: services.ts is
 * intentionally left untouched (its prod default must stay exactly as-is),
 * and this is a plain Node script that must not pull in electron/ code. Keep
 * the two switches in sync by hand if either platform list changes.
 */
export function prodDataDirDefault({ env, platform, homedir }) {
  switch (platform) {
    case 'darwin':
      return path.join(homedir, 'Library', 'Application Support', 'slipstream')
    case 'win32':
      return path.join(env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'), 'slipstream')
    default:
      // Linux / XDG
      return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir, '.config'), 'slipstream')
  }
}

/** True if `child` is `parent` itself or nested somewhere underneath it. */
function isPathInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * resolveDevDataDir — pure decision for what SLIPSTREAM_DATA_DIR (if
 * anything) scripts/dev.mjs should set before spawning the wrapped command.
 * Takes every input as an argument so it has no I/O and no hidden state.
 *
 * Main worktree: unchanged from the original behavior — respect an
 * explicitly set SLIPSTREAM_DATA_DIR, else leave it unset so
 * resolveDataDir()'s existing prod default applies.
 *
 * Linked worktree: the entire point of this script is isolating a worktree
 * from prod, but the Slipstream daemon injects SLIPSTREAM_DATA_DIR=<prod
 * dir> into every agent PTY it spawns (see electron/services/agentEnv.ts /
 * agentCliProvision.ts) — so an agent working inside a linked worktree
 * always inherits the PROD value, and "respect whatever's already set"
 * silently points `pnpm dev` at production. So here: a SLIPSTREAM_DATA_DIR
 * that's unset, equal to the prod data dir, or nested inside it, is treated
 * as an inherited prod value and OVERRIDDEN with the worktree's own dev data
 * dir. Only a value that resolves somewhere genuinely outside the prod data
 * dir (a deliberate override — a test dir, another slot, etc.) is respected.
 *
 * @param {object} args
 * @param {NodeJS.ProcessEnv} args.env
 * @param {boolean} args.isLinkedWorktree
 * @param {string|undefined} args.root - `git rev-parse --show-toplevel` for this checkout.
 * @param {{slots: Record<string, {root: string, dataDir: string}>}|undefined} args.registry
 * @param {string} args.platform - process.platform
 * @param {string} args.homedir - os.homedir()
 * @returns {{dataDir: string|undefined, reason: string}}
 */
export function resolveDevDataDir({ env, isLinkedWorktree, root, registry, platform, homedir }) {
  const prodDataDir = path.resolve(
    env.SLIPSTREAM_PROD_DATA_DIR || prodDataDirDefault({ env, platform, homedir }),
  )

  if (!isLinkedWorktree) {
    if (env.SLIPSTREAM_DATA_DIR) {
      return { dataDir: env.SLIPSTREAM_DATA_DIR, reason: 'explicit env' }
    }
    return { dataDir: undefined, reason: 'main worktree (prod default)' }
  }

  if (!root) {
    // Can't determine the worktree root — fail toward "leave unset" (same
    // as main-worktree behavior) rather than guess at a dev dir.
    return { dataDir: undefined, reason: 'could not resolve worktree root' }
  }

  const slug = slugForRoot(root)
  const registered = registry?.slots?.[slug]
  const isRegistered = Boolean(registered && registered.root === root)
  const worktreeDevDir = isRegistered ? registered.dataDir : path.join(DEV_DATA_ROOT, slug)
  const slotReason = isRegistered
    ? `registered dev slot (${slug})`
    : `unregistered dev slot (${slug})`

  const rawEnvDataDir = env.SLIPSTREAM_DATA_DIR
  if (!rawEnvDataDir) {
    return { dataDir: worktreeDevDir, reason: slotReason }
  }

  const resolvedEnvDataDir = path.resolve(rawEnvDataDir)
  const pointsAtProd =
    resolvedEnvDataDir === prodDataDir || isPathInside(resolvedEnvDataDir, prodDataDir)

  if (pointsAtProd) {
    return {
      dataDir: worktreeDevDir,
      reason: 'worktree isolation — overriding inherited prod data dir',
    }
  }

  return { dataDir: rawEnvDataDir, reason: 'explicit env' }
}
