// devSlots.mjs — registry of per-worktree "dev slots" (port + tsPort +
// dataDir) so each linked git worktree gets its own isolated dev instance
// that can never collide with production (port 7421) or with each other.
//
// The pure functions below (slugForRoot, allocatePort, nextSlot,
// pruneRegistry) take/return plain data and do no I/O — see
// devSlots.test.mjs. readRegistry/writeRegistry/listeningPorts are the thin
// impure edges that scripts/dev-slot.mjs wires them to disk/the OS.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

export const CONFIG_DIR = path.join(homedir(), '.config', 'slipstream')
export const REGISTRY_PATH = path.join(CONFIG_DIR, 'dev-slots.json')

// Dev instance DATA dirs live OUTSIDE the prod data dir (CONFIG_DIR) — never
// nested under it. A dataDir nested inside CONFIG_DIR would break bwrap
// containment: the sandbox's `--tmpfs`-over-CONFIG_DIR (see
// electron/services/agentSandbox.ts's prodDataDir handling) would shadow
// anything living underneath it, including the dev instance's own
// `sessions/<sid>` bind mount that the daemon's fs.watch status sentinel
// depends on. Per-slot ENV files intentionally stay under
// CONFIG_DIR/dev-slots/<slug>.env — only the DATA dir moves here.
export const DEV_DATA_ROOT = path.join(homedir(), '.local', 'share', 'slipstream-dev')

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
 * (`dev-slots/<slug>.env`) that deploy.sh writes — that mismatch is exactly
 * what caused the "Failed to load environment files" restart failure this
 * function fixes. Keep in sync with scripts/deploy.sh's DEV_UNIT.
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

/** readRegistry — loads REGISTRY_PATH, or an empty registry if absent/invalid. */
export function readRegistry() {
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf-8')
    return normalizeRegistry(JSON.parse(raw))
  } catch {
    return emptyRegistry()
  }
}

/** writeRegistry — persists `registry` to REGISTRY_PATH, mode 600. */
export function writeRegistry(registry) {
  mkdirSync(CONFIG_DIR, { recursive: true })
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
