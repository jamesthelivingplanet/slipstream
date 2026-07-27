#!/usr/bin/env node
// dev.mjs — resolves the correct SLIPSTREAM_DATA_DIR for the CURRENT
// checkout, then re-execs the real dev command with it set in the child's
// env. Exists because electron/core/services.ts's resolveDataDir() falls
// back to the shared prod data dir (~/.config/slipstream) when
// SLIPSTREAM_DATA_DIR is unset — so a plain `pnpm dev` (or `pnpm
// dev:backend`) run from a linked worktree would otherwise read/write
// PRODUCTION's slipstream.db, sessions/, and secret.key. resolveDataDir()
// itself is intentionally left untouched (prod's default must stay exactly
// as it is); this script only decides what to *set* before that function
// ever runs.
//
// The actual decision is a pure function, resolveDevDataDir() in
// ./lib/devDataDir.mjs (see that file for the full rationale and unit
// tests in devDataDir.test.mjs) — in short:
//   - Main worktree: respect an explicit SLIPSTREAM_DATA_DIR, else leave it
//     unset so resolveDataDir()'s prod default applies, exactly as before.
//   - Linked worktree: the Slipstream daemon injects SLIPSTREAM_DATA_DIR=
//     <prod dir> into every agent PTY it spawns (electron/services/
//     agentEnv.ts), so an inherited value pointing at (or inside) the prod
//     data dir is OVERRIDDEN with this worktree's own dev data dir
//     (registered dev-slot's dataDir if one exists, else
//     DEV_DATA_ROOT/<slug>). Only a value that's genuinely outside the prod
//     data dir — a deliberate override — is respected as-is.
//
// Usage: node scripts/dev.mjs <command> [args...]
//   e.g. node scripts/dev.mjs vite
//        node scripts/dev.mjs node scripts/dev-backend.mjs

import { execFileSync, spawn } from 'node:child_process'
import { constants as osConstants, homedir } from 'node:os'
import path from 'node:path'
import { readRegistry } from './lib/devSlots.mjs'
import { resolveDevDataDir } from './lib/devDataDir.mjs'

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

/** Mirrors scripts/lib/target.sh's slipstream_is_linked_worktree(). */
function isLinkedWorktree() {
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  const commonDirRaw = git(['rev-parse', '--git-common-dir'])
  if (!gitDir || !commonDirRaw) return false
  const commonDir = path.resolve(commonDirRaw)
  return gitDir !== commonDir
}

function resolveDataDirForCheckout() {
  const linked = isLinkedWorktree()
  const root = linked ? git(['rev-parse', '--show-toplevel']) : ''
  const registry = readRegistry()

  const { dataDir, reason } = resolveDevDataDir({
    env: process.env,
    isLinkedWorktree: linked,
    root: root || undefined,
    registry,
    platform: process.platform,
    homedir: homedir(),
  })

  return { dataDir, source: reason }
}

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd) {
    console.error('Usage: node scripts/dev.mjs <command> [args...]')
    process.exit(1)
  }

  const { dataDir, source } = resolveDataDirForCheckout()

  const env = { ...process.env }
  if (dataDir) {
    env.SLIPSTREAM_DATA_DIR = dataDir
    console.log(`==> using dev data dir: ${dataDir} (${source})`)
  } else {
    console.log(`==> SLIPSTREAM_DATA_DIR left unset — ${source}`)
  }

  const child = spawn(cmd, args, { env, stdio: 'inherit' })

  // Forward signals faithfully so Ctrl-C / termination behaves the same as
  // running the wrapped command directly.
  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      // Mirror the conventional shell exit-code encoding for signal death
      // (128 + signal number) since we have our own signal handlers
      // registered above (which would otherwise suppress Node's default
      // signal-exit behavior if we just re-raised on ourselves).
      const signalNumber = osConstants.signals[signal]
      process.exit(signalNumber ? 128 + signalNumber : 1)
    }
    process.exit(code ?? 0)
  })

  child.on('error', (err) => {
    console.error(`==> failed to launch '${cmd}': ${err.message}`)
    process.exit(1)
  })
}

main()
