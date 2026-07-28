#!/usr/bin/env node
// dev-slot.mjs — CLI over scripts/lib/devSlots.mjs's on-disk dev-slot
// registry (~/.config/slipstream/dev-slots.json). scripts/deploy.sh's dev
// path shells out to this to allocate/reclaim the isolated port+dataDir
// slot for a linked worktree's dev instance.
//
// Subcommands:
//   acquire --root <abs path>   allocate/reuse a slot for a worktree root;
//                                 prints it as shell-eval-able KEY=value lines
//   release --slug <slug>        remove a slot from the registry
//   down --slug <slug>           stop+disable the systemd unit, remove the
//                                 per-slot env file, and release the slot
//   list                         human-readable table of all registered slots
//   prune                        drop slots whose root no longer exists,
//                                 reclaiming each one exactly like `down`
//                                 (unit stopped+disabled, env file removed,
//                                 Tailscale mapping released) and printing
//                                 what was reclaimed for each removed slug
//
// Usage (from deploy.sh):
//   eval "$(node scripts/dev-slot.mjs acquire --root "$REPO_ROOT")"

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  readRegistry,
  writeRegistry,
  nextSlot,
  pruneRegistry,
  listeningPorts,
  devUnitName,
  isDevUnit,
  releaseTsPort,
  CONFIG_DIR,
} from './lib/devSlots.mjs'

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    } else {
      args._.push(arg)
    }
  }
  return args
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function requireString(args, key, subcommand) {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${subcommand} requires --${key} <value>`)
  }
  return value
}

function cmdAcquire(args) {
  const root = requireString(args, 'root', 'acquire')
  if (!path.isAbsolute(root)) {
    fail(`--root must be an absolute path, got: ${root}`)
  }

  const registry = readRegistry()
  const busyPorts = listeningPorts()
  const { registry: newRegistry, slot } = nextSlot(registry, root, { busyPorts })
  writeRegistry(newRegistry)

  console.log(`SLIPSTREAM_SLOT_SLUG=${shQuote(slot.slug)}`)
  console.log(`SLIPSTREAM_SLOT_PORT=${shQuote(slot.port)}`)
  console.log(`SLIPSTREAM_SLOT_TS_PORT=${shQuote(slot.tsPort)}`)
  console.log(`SLIPSTREAM_SLOT_DATA_DIR=${shQuote(slot.dataDir)}`)
  console.log(`SLIPSTREAM_SLOT_ROOT=${shQuote(slot.root)}`)
}

function cmdRelease(args) {
  const slug = requireString(args, 'slug', 'release')

  const registry = readRegistry()
  if (!registry.slots[slug]) {
    fail(`no such slot: ${slug}`)
  }

  const slots = { ...registry.slots }
  delete slots[slug]
  writeRegistry({ version: registry.version, slots })
  console.log(slug)
}

/**
 * reclaimSlot — tears down everything a dev slot owns OUTSIDE the registry:
 * stops+disables its systemd unit, removes its per-slot env file, and
 * releases its Tailscale mapping. This is the single function `cmdDown` and
 * `cmdPrune` both call — the drift between two separately-maintained copies
 * of this logic is exactly what let a pruned slot's unit keep running
 * against a deleted worktree (still `active`, still holding its port and
 * tsPort mapping, still enabled so it restart-loops on reboot).
 *
 * Every step is best-effort: caught and ignored independently, so one
 * failure (unit already stopped, env file already gone, tailscale not
 * installed) can never abort the remaining steps for this slot, nor abort a
 * caller's loop over other slots.
 *
 * `tsPort` must be read from the registry BEFORE the caller removes the
 * slot — once gone there's no way to recover which tailnet port it held.
 *
 * Returns { unit, envFile, releasedTsPort, reclaimed } where `reclaimed` is
 * a human-readable list of the steps that actually completed, for callers
 * that want to report it.
 */
function reclaimSlot(slug, tsPort) {
  const unit = devUnitName(slug)
  const envFile = path.join(CONFIG_DIR, 'dev-slots', `${slug}.env`)
  const reclaimed = []

  // Safety guard: never let a malformed/hostile slug produce a unit name
  // that systemctl would apply to something other than a dev slot (in
  // particular, production's `slipstream.service`).
  if (isDevUnit(unit)) {
    try {
      execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
      reclaimed.push(`stopped ${unit}`)
    } catch {
      // best-effort — unit may not be running
    }
    try {
      execFileSync('systemctl', ['--user', 'disable', unit], { stdio: 'ignore' })
      reclaimed.push(`disabled ${unit}`)
    } catch {
      // best-effort — unit may not be enabled
    }
  } else {
    reclaimed.push(`skipped systemctl (unsafe unit name: ${JSON.stringify(unit)})`)
  }

  try {
    rmSync(envFile, { force: true })
    reclaimed.push(`removed ${envFile}`)
  } catch {
    // best-effort — file may already be gone, or unremovable
  }

  let releasedTsPort = null
  try {
    releasedTsPort = releaseTsPort(tsPort)
  } catch {
    // releaseTsPort already swallows internally; belt-and-suspenders so a
    // future change to it still can't take down the rest of this reclaim.
  }
  if (releasedTsPort !== null) {
    reclaimed.push(`released tailscale serve --https=${releasedTsPort}`)
  }

  return { unit, envFile, releasedTsPort, reclaimed }
}

function cmdDown(args) {
  const slug = requireString(args, 'slug', 'down')

  const registry = readRegistry()
  const slot = registry.slots[slug]
  if (!slot) {
    fail(`no such slot: ${slug}`)
  }

  // Read tsPort off the slot BEFORE it's released below — once the slot is
  // gone from the registry there is no way to recover which tailnet port it
  // held, and the mapping would leak forever (the bug this fixes).
  const { unit, envFile, releasedTsPort } = reclaimSlot(slug, slot.tsPort)

  const slots = { ...registry.slots }
  delete slots[slug]
  writeRegistry({ version: registry.version, slots })

  const tsSummary =
    releasedTsPort !== null ? `, turned off tailscale serve --https=${releasedTsPort}` : ''
  console.log(
    `down: stopped+disabled ${unit}, removed ${envFile}, released slot ${slug}${tsSummary}`,
  )
}

function cmdList() {
  const registry = readRegistry()
  const slugs = Object.keys(registry.slots)

  if (slugs.length === 0) {
    console.log('(no dev slots registered)')
    return
  }

  const rows = slugs.map((slug) => {
    const slot = registry.slots[slug]
    return {
      slug: slot.slug,
      port: String(slot.port),
      tsPort: String(slot.tsPort),
      root: slot.root,
      exists: existsSync(slot.root) ? 'yes' : 'MISSING',
    }
  })

  const header = { slug: 'SLUG', port: 'PORT', tsPort: 'TSPORT', root: 'ROOT', exists: 'EXISTS' }
  const widths = {
    slug: Math.max(header.slug.length, ...rows.map((r) => r.slug.length)),
    port: Math.max(header.port.length, ...rows.map((r) => r.port.length)),
    tsPort: Math.max(header.tsPort.length, ...rows.map((r) => r.tsPort.length)),
    root: Math.max(header.root.length, ...rows.map((r) => r.root.length)),
    exists: header.exists.length,
  }

  const fmt = (row) =>
    [
      row.slug.padEnd(widths.slug),
      row.port.padEnd(widths.port),
      row.tsPort.padEnd(widths.tsPort),
      row.root.padEnd(widths.root),
      row.exists.padEnd(widths.exists),
    ].join('  ')

  console.log(fmt(header))
  for (const row of rows) {
    console.log(fmt(row))
  }
}

function cmdPrune() {
  const registry = readRegistry()
  const { registry: pruned, removed } = pruneRegistry(registry, (root) => existsSync(root))
  writeRegistry(pruned)
  for (const slug of removed) {
    // Reclaim everything this slot owns OUTSIDE the registry the exact same
    // way `down` does — this is the bug this function fixes: a pruned slot
    // used to keep its systemd unit running (still active, still enabled,
    // still holding its port) and its env file behind, because only the
    // registry entry and the tsPort mapping were ever reclaimed here.
    //
    // Look up the tsPort from the PRE-prune registry — `pruned` no longer
    // has this slug, and a dropped worktree's tailnet mapping would
    // otherwise leak forever.
    let reclaimed = []
    try {
      ;({ reclaimed } = reclaimSlot(slug, registry.slots[slug]?.tsPort))
    } catch (err) {
      // Must never abort pruning of the remaining slots over one slot's
      // teardown failure — reclaimSlot() already swallows its own steps'
      // errors, so reaching here means something unexpected; report and
      // move on rather than losing the rest of the batch.
      reclaimed = [`reclaim failed: ${err.message}`]
    }
    console.log(`${slug}: ${reclaimed.join(', ')}`)
  }
}

function main() {
  const [, , subcommand, ...rest] = process.argv
  const args = parseArgs(rest)

  switch (subcommand) {
    case 'acquire':
      cmdAcquire(args)
      break
    case 'release':
      cmdRelease(args)
      break
    case 'down':
      cmdDown(args)
      break
    case 'list':
      cmdList()
      break
    case 'prune':
      cmdPrune()
      break
    default:
      fail(
        `unknown or missing subcommand '${subcommand ?? ''}'. ` +
          'Usage: node scripts/dev-slot.mjs <acquire --root <path>|release --slug <slug>|down --slug <slug>|list|prune>',
      )
  }
}

main()
