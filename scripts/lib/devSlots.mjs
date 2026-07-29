// devSlots.mjs — registry of per-worktree "dev slots" (port + tsPort +
// dataDir) so each linked git worktree gets its own isolated dev instance
// that can never collide with production (port 7421) or with each other.
//
// The pure functions below (slugForRoot, allocatePort, nextSlot,
// pruneRegistry) take/return plain data and do no I/O — see
// devSlots.test.mjs. readRegistry/writeRegistry/listeningPorts are the thin
// impure edges that scripts/dev-slot.mjs wires them to disk/the OS.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

// Prod's data dir — kept as a named constant because it's still the source
// for the legacy-registry migration below (and callers reference it for
// documentation/comparisons), even though no dev-slot state lives under it
// anymore (see TASK-WH96T).
export const CONFIG_DIR = path.join(homedir(), '.config', 'slipstream')

// Dev instance DATA dirs, the slot REGISTRY, and per-slot ENV files all live
// under this root, OUTSIDE the prod data dir (CONFIG_DIR) — never nested
// under it. Nesting any of them inside CONFIG_DIR breaks bwrap containment
// two different ways:
//   1. (dataDir) the sandbox's `--tmpfs`-over-CONFIG_DIR (see
//      electron/services/agentSandbox.ts's prodDataDir handling) would
//      shadow anything living underneath it, including the dev instance's
//      own `sessions/<sid>` bind mount that the daemon's fs.watch status
//      sentinel depends on.
//   2. (registry + per-slot env) that SAME tmpfs shadow means any agent PTY
//      spawned inside a bwrap sandbox (SLIPSTREAM_SANDBOX=bwrap, on by
//      default for dev slots — see docs/DEVELOPMENT.md) sees its own
//      PRIVATE, empty view of CONFIG_DIR: writes to a registry/env file
//      under there land in that agent's tmpfs, invisible to systemd on the
//      host. `pnpm deploy` from inside such an agent used to fail with
//      "Failed to load environment files" (env file "written" but never
//      seen by the host), and `acquire`/`pnpm dev:slots` would see an empty
//      registry and re-allocate ports already in use. This is the
//      TASK-WH96T bug — moving the registry and per-slot env files out here
//      fixes it the same way the dataDir move already did.
export const DEV_DATA_ROOT = path.join(homedir(), '.local', 'share', 'slipstream-dev')

export const REGISTRY_PATH = path.join(DEV_DATA_ROOT, 'slots.json')
export const SLOT_ENV_DIR = path.join(DEV_DATA_ROOT, 'slots')

// ---------------------------------------------------------------------------
// TRANSITIONAL SHIM (TASK-WH96T) — delete once every machine has been
// redeployed onto the new ~/.local/share/slipstream-dev layout above. Before
// this change, the registry and per-slot env files lived under CONFIG_DIR
// (~/.config/slipstream/dev-slots.json, ~/.config/slipstream/dev-slots/);
// readRegistry() below best-effort migrates from these legacy paths so an
// existing install doesn't strand a running dev slot on upgrade.
// ---------------------------------------------------------------------------
export const LEGACY_REGISTRY_PATH = path.join(CONFIG_DIR, 'dev-slots.json')
export const LEGACY_SLOT_ENV_DIR = path.join(CONFIG_DIR, 'dev-slots')

export const PORT_BASE = 7431
export const TS_PORT_BASE = 8443

// Ports that must never be handed out as a dev slot, regardless of what
// else is free — 7421 is the production server port, 443 is the production
// Tailscale HTTPS port.
const RESERVED_PORTS = new Set([7421, 443])

function emptyRegistry() {
  return { version: 1, slots: {} }
}

function normalizeRegistry(registry) {
  if (
    registry &&
    typeof registry === 'object' &&
    registry.slots &&
    typeof registry.slots === 'object'
  ) {
    return { version: registry.version || 1, slots: registry.slots }
  }
  return emptyRegistry()
}

/**
 * slugForRoot — systemd-safe slug for a worktree root: the basename of the
 * path, with every character outside [A-Za-z0-9_.-] replaced by '-', and
 * runs of '-' collapsed to a single '-'. Mirrors slipstream_worktree_slug()
 * in scripts/lib/target.sh — keep the two in sync.
 */
export function slugForRoot(root) {
  const base = path.basename(root)
  return base.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-')
}

/**
 * devUnitName — systemd unit name for a dev slot's slug. The slug from
 * slugForRoot() is already restricted to [A-Za-z0-9_.-], which is a valid
 * systemd template instance name verbatim — so it is used raw with `%i`
 * (NOT `systemd-escape`d, and the unit template must use `%i`, not `%I`).
 * `systemd-escape` would turn '-' into the literal string '\x2d', which
 * desyncs the escaped `%i` instance name from the plain-slug env filename
 * (`slots/<slug>.env` under SLOT_ENV_DIR) that deploy.sh writes — that
 * mismatch is exactly what caused the "Failed to load environment files"
 * restart failure this function fixes. Keep in sync with scripts/deploy.sh's
 * DEV_UNIT.
 */
export function devUnitName(slug) {
  return `slipstream-dev@${slug}.service`
}

/**
 * isDevUnit — true iff `unit` is safe to pass to a mutating `systemctl
 * --user` call (stop/disable) as part of reclaiming a dev slot. This is the
 * one guard standing between "tear down this dev slot's unit" and
 * "accidentally target production's `slipstream.service`" if a slug were
 * ever empty, malformed, or crafted (e.g. containing '/' or '..' so it
 * doesn't round-trip through devUnitName as expected) — kept pure and
 * exported so it's unit-testable directly, and so every teardown path
 * (down, prune) shares the exact same check instead of re-deriving it.
 *
 * Deliberately just a prefix check: any string that doesn't start with
 * 'slipstream-dev@' is refused outright, `slipstream.service` (prod) very
 * much included.
 */
export function isDevUnit(unit) {
  return typeof unit === 'string' && unit.startsWith('slipstream-dev@')
}

/**
 * allocatePort — lowest integer >= base that is not present in `taken`
 * (a Set or array of numbers).
 */
export function allocatePort(taken, base) {
  const takenSet = taken instanceof Set ? taken : new Set(taken)
  let port = base
  while (takenSet.has(port)) {
    port += 1
  }
  return port
}

/**
 * nextSlot — returns {registry, slot} for `root`. Reuses the existing slot
 * for that root's slug when its recorded root still matches (idempotent:
 * calling twice for the same root returns the same slot and an unchanged
 * registry). Otherwise allocates a fresh port (>= PORT_BASE) and tsPort
 * (>= TS_PORT_BASE), avoiding every port already recorded in the registry,
 * every port in opts.busyPorts, and always excluding 7421/443.
 */
export function nextSlot(registry, root, opts = {}) {
  const reg = normalizeRegistry(registry)
  const slug = slugForRoot(root)
  const busyPorts = opts.busyPorts || []

  const existing = reg.slots[slug]
  if (existing && existing.root === root) {
    return { registry: reg, slot: existing }
  }

  const recordedPorts = Object.values(reg.slots).map((s) => s.port)
  const recordedTsPorts = Object.values(reg.slots).map((s) => s.tsPort)

  const takenPorts = new Set([...RESERVED_PORTS, ...busyPorts, ...recordedPorts])
  const takenTsPorts = new Set([...RESERVED_PORTS, ...busyPorts, ...recordedTsPorts])

  const port = allocatePort(takenPorts, PORT_BASE)
  const tsPort = allocatePort(takenTsPorts, TS_PORT_BASE)

  const slot = {
    slug,
    root,
    port,
    tsPort,
    dataDir: path.join(DEV_DATA_ROOT, slug),
    createdAt: new Date().toISOString(),
  }

  const newRegistry = {
    version: reg.version,
    slots: { ...reg.slots, [slug]: slot },
  }

  return { registry: newRegistry, slot }
}

/**
 * shouldReleaseTsPort — true iff `tsPort` is safe to hand to
 * `tailscale serve --https=<tsPort> off`. This is the one guard standing
 * between "reclaim a dev slot's tailnet endpoint" and "accidentally tear
 * down production's `:443` mapping" — kept pure and exported so it can be
 * unit-tested directly, and so both the `down` and `prune` code paths share
 * the exact same check (see releaseTsPort below) instead of re-deriving it.
 *
 * Rejects: 443 (prod's port, always reserved — see RESERVED_PORTS above),
 * and anything that isn't a positive integer (undefined/null/0/NaN/etc,
 * which can show up for a malformed or hand-edited registry entry). Accepts
 * numeric strings (e.g. '8443') since the registry round-trips through
 * JSON and callers may hand back a string.
 */
export function shouldReleaseTsPort(tsPort) {
  const n = Number(tsPort)
  return Number.isInteger(n) && n > 0 && n !== 443
}

/**
 * releaseTsPort — best-effort turn off a dev slot's Tailscale HTTPS mapping
 * (`tailscale serve --https=<tsPort> off`) before the slot itself is
 * released from the registry. Guarded by shouldReleaseTsPort so a missing or
 * bogus tsPort (in particular 443) is skipped rather than risking prod's
 * mapping. Never throws: tailscale may not be installed, or the mapping may
 * already be gone — teardown (down/prune) must succeed regardless.
 *
 * `run` defaults to execFileSync against the real `tailscale` binary but is
 * injectable so tests can assert on invocation without shelling out.
 *
 * Returns the tsPort that was released, or null if it was skipped.
 */
export function releaseTsPort(tsPort, run = execFileSync) {
  if (!shouldReleaseTsPort(tsPort)) {
    return null
  }
  const n = Number(tsPort)
  try {
    run('tailscale', ['serve', `--https=${n}`, 'off'], { stdio: 'ignore' })
  } catch {
    // best-effort — tailscale may not be installed, or the mapping may
    // already be gone. Teardown must still succeed.
  }
  return n
}

/**
 * pruneRegistry — drops every slot whose `root` fails `existsFn(root)`.
 * Returns {registry, removed:[slug,...]}.
 */
export function pruneRegistry(registry, existsFn) {
  const reg = normalizeRegistry(registry)
  const removed = []
  const slots = {}

  for (const [slug, slot] of Object.entries(reg.slots)) {
    if (existsFn(slot.root)) {
      slots[slug] = slot
    } else {
      removed.push(slug)
    }
  }

  return { registry: { version: reg.version, slots }, removed }
}

// ---------------------------------------------------------------------------
// Impure helpers — thin fs/OS edges, not unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * readRegistry — loads REGISTRY_PATH, or an empty registry if absent/invalid.
 *
 * TRANSITIONAL SHIM (TASK-WH96T, delete once migrated fleet-wide): if the
 * new registry file is absent, best-effort falls back to migrating the
 * legacy pre-TASK-WH96T registry (LEGACY_REGISTRY_PATH, under
 * ~/.config/slipstream) before giving up and returning empty. This must
 * NEVER throw or treat an unreadable legacy path as an error — inside a
 * bwrap-sandboxed agent, ~/.config/slipstream is a private tmpfs, so the
 * legacy path will look absent even when a real registry exists on the
 * host. That case is indistinguishable from "nothing to migrate" from
 * inside the sandbox, and must be treated as such rather than failing.
 */
export function readRegistry() {
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf-8')
    return normalizeRegistry(JSON.parse(raw))
  } catch {
    return migrateLegacyRegistry()
  }
}

/**
 * migrateLegacyRegistry — TRANSITIONAL SHIM (TASK-WH96T, delete once
 * migrated fleet-wide). Reads LEGACY_REGISTRY_PATH if present/readable,
 * writes it out to the new REGISTRY_PATH, best-effort copies any legacy
 * per-slot env files alongside it, and returns the migrated registry.
 * Returns an empty registry (never throws) if the legacy path is missing,
 * unreadable, or not valid JSON — all of which are "nothing to migrate",
 * not errors, per the sandbox note on readRegistry above.
 */
function migrateLegacyRegistry() {
  try {
    const raw = readFileSync(LEGACY_REGISTRY_PATH, 'utf-8')
    const registry = normalizeRegistry(JSON.parse(raw))
    writeRegistry(registry)
    migrateLegacySlotEnvFiles(registry)
    return registry
  } catch {
    return emptyRegistry()
  }
}

/**
 * migrateLegacySlotEnvFiles — TRANSITIONAL SHIM (TASK-WH96T, delete once
 * migrated fleet-wide). Best-effort copies each slot's legacy per-slot env
 * file (LEGACY_SLOT_ENV_DIR/<slug>.env) into the new SLOT_ENV_DIR, if it
 * exists there and hasn't already been copied. Every step is independently
 * best-effort: a missing/unreadable legacy dir or a single slot's copy
 * failing must never abort the registry migration itself.
 */
function migrateLegacySlotEnvFiles(registry) {
  try {
    mkdirSync(SLOT_ENV_DIR, { recursive: true })
    chmodSync(SLOT_ENV_DIR, 0o700)
  } catch {
    return
  }
  for (const slug of Object.keys(registry.slots)) {
    try {
      const src = path.join(LEGACY_SLOT_ENV_DIR, `${slug}.env`)
      const dest = path.join(SLOT_ENV_DIR, `${slug}.env`)
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest)
        chmodSync(dest, 0o600)
      }
    } catch {
      // best-effort per slot — one unreadable/uncopyable legacy env file
      // must not abort migration of the rest.
    }
  }
}

/** writeRegistry — persists `registry` to REGISTRY_PATH, mode 600. */
export function writeRegistry(registry) {
  mkdirSync(DEV_DATA_ROOT, { recursive: true })
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n')
  chmodSync(REGISTRY_PATH, 0o600)
}

/**
 * listeningPorts — best-effort list of TCP ports currently listening on this
 * machine (parsed from `ss -lnt`). Returns [] on any failure (missing `ss`,
 * parse error, etc.) — this is a defensive extra signal, never load-bearing.
 */
export function listeningPorts() {
  try {
    const out = execSync('ss -lnt', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const ports = []
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      const local = cols[3]
      if (!local) continue
      const match = local.match(/:(\d+)$/)
      if (match) ports.push(Number(match[1]))
    }
    return ports
  } catch {
    return []
  }
}

// existsSync is re-exported so callers (dev-slot.mjs) can pass a real
// filesystem check into pruneRegistry without importing node:fs themselves.
export { existsSync }
