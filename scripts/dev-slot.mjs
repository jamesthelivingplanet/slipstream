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
//                                 printing each removed slug on its own line
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

function unitNameFor(slug) {
  try {
    return execFileSync('systemd-escape', [slug], { encoding: 'utf-8' }).trim()
  } catch {
    // systemd-escape unavailable — fall back to the raw slug.
    return slug
  }
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

function cmdDown(args) {
  const slug = requireString(args, 'slug', 'down')

  const registry = readRegistry()
  if (!registry.slots[slug]) {
    fail(`no such slot: ${slug}`)
  }

  const unit = `slipstream-dev@${unitNameFor(slug)}.service`

  try {
    execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  } catch {
    // best-effort — unit may not be running
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', unit], { stdio: 'ignore' })
  } catch {
    // best-effort — unit may not be enabled
  }

  const envFile = path.join(CONFIG_DIR, 'dev-slots', `${slug}.env`)
  rmSync(envFile, { force: true })

  const slots = { ...registry.slots }
  delete slots[slug]
  writeRegistry({ version: registry.version, slots })

  console.log(`down: stopped+disabled ${unit}, removed ${envFile}, released slot ${slug}`)
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
    console.log(slug)
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
