import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import {
  slugForRoot,
  allocatePort,
  nextSlot,
  pruneRegistry,
  devUnitName,
  shouldReleaseTsPort,
  releaseTsPort,
  PORT_BASE,
  TS_PORT_BASE,
  CONFIG_DIR,
  DEV_DATA_ROOT,
} from './devSlots.mjs'

describe('slugForRoot', () => {
  it('uses the basename of the root path', () => {
    expect(slugForRoot('/home/user/.repositories/slipstream')).toBe('slipstream')
  })

  it('replaces characters outside [A-Za-z0-9_.-] with a dash', () => {
    expect(slugForRoot('/tmp/my worktree!@#')).toBe('my-worktree-')
  })

  it('collapses runs of dashes into one', () => {
    expect(slugForRoot('/tmp/a   b')).toBe('a-b')
  })

  it('leaves an already-safe name untouched', () => {
    expect(slugForRoot('/tmp/TASK-WH96T-dev-environment')).toBe('TASK-WH96T-dev-environment')
  })
})

describe('allocatePort', () => {
  it('returns the base port when nothing is taken', () => {
    expect(allocatePort(new Set(), 7431)).toBe(7431)
  })

  it('skips taken ports, returning the lowest free one', () => {
    expect(allocatePort(new Set([7431, 7432, 7433]), 7431)).toBe(7434)
  })

  it('accepts a plain array as well as a Set', () => {
    expect(allocatePort([7431, 7432], 7431)).toBe(7433)
  })

  it('handles a gap in the middle of the taken range', () => {
    expect(allocatePort(new Set([7431, 7433]), 7431)).toBe(7432)
  })
})

describe('nextSlot', () => {
  const emptyRegistry = { version: 1, slots: {} }

  it('is idempotent: calling twice for the same root returns the same slot and registry', () => {
    const first = nextSlot(emptyRegistry, '/repo/a')
    const second = nextSlot(first.registry, '/repo/a')
    expect(second.slot).toEqual(first.slot)
    expect(second.registry).toEqual(first.registry)
  })

  it('never allocates port 7421 or 443', () => {
    const { slot } = nextSlot(emptyRegistry, '/repo/a')
    expect(slot.port).not.toBe(7421)
    expect(slot.tsPort).not.toBe(443)
    expect(slot.port).toBeGreaterThanOrEqual(PORT_BASE)
    expect(slot.tsPort).toBeGreaterThanOrEqual(TS_PORT_BASE)
  })

  it('avoids ports passed in opts.busyPorts', () => {
    const { slot } = nextSlot(emptyRegistry, '/repo/a', { busyPorts: [7431, 7432] })
    expect(slot.port).toBe(7433)
  })

  it('avoids ports already recorded in the registry for other slots', () => {
    const first = nextSlot(emptyRegistry, '/repo/a')
    const second = nextSlot(first.registry, '/repo/b')
    expect(second.slot.port).not.toBe(first.slot.port)
    expect(second.slot.tsPort).not.toBe(first.slot.tsPort)
    expect(second.slot.slug).not.toBe(first.slot.slug)
  })

  it('reallocates (not reuses) when the slug matches but the root differs', () => {
    // Two different absolute paths that share a basename would collide on
    // slug; nextSlot must not silently hand back the other root's slot.
    const first = nextSlot(emptyRegistry, '/repo/a/dup')
    const second = nextSlot(first.registry, '/repo/b/dup')
    expect(second.slot.root).toBe('/repo/b/dup')
    expect(second.slot).not.toEqual(first.slot)
  })

  it('allocates the dataDir under DEV_DATA_ROOT, not CONFIG_DIR', () => {
    const { slot } = nextSlot(emptyRegistry, '/repo/a')
    expect(slot.dataDir).toBe(path.join(DEV_DATA_ROOT, slot.slug))
  })

  it('never allocates a dataDir nested inside the prod config dir', () => {
    // Nesting the dev data dir inside CONFIG_DIR would break bwrap
    // containment: the sandbox's tmpfs-over-CONFIG_DIR would shadow
    // anything living underneath it, including the dev session bind mount.
    const { slot } = nextSlot(emptyRegistry, '/repo/a')
    const relative = path.relative(CONFIG_DIR, slot.dataDir)
    const isNestedInConfigDir =
      relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    expect(isNestedInConfigDir).toBe(false)
  })
})

describe('devUnitName', () => {
  it('uses the raw slug verbatim, with no systemd-escape sequences', () => {
    const slug = 'TASK-WH96T-dev-environment'
    const unit = devUnitName(slug)
    expect(unit).toBe('slipstream-dev@TASK-WH96T-dev-environment.service')
    expect(unit).not.toContain('\\x2d')
  })

  it('keeps the unit instance name identical to the env-file basename deploy.sh writes', () => {
    // Invariant that broke: systemd-escape'ing the unit instance while
    // deploy.sh wrote the env file under the raw slug meant `%i` could
    // never resolve to the file on disk for any hyphenated slug.
    const slug = slugForRoot('/home/user/.worktrees/TASK-WH96T-dev-environment')
    const envFileBasename = `${slug}.env`
    const unit = devUnitName(slug)
    expect(unit).toBe(`slipstream-dev@${envFileBasename.replace(/\.env$/, '')}.service`)
    expect(envFileBasename).toBe('TASK-WH96T-dev-environment.env')
  })
})

describe('shouldReleaseTsPort', () => {
  it('allows a normal dev slot tsPort', () => {
    expect(shouldReleaseTsPort(8443)).toBe(true)
    expect(shouldReleaseTsPort(8444)).toBe(true)
  })

  it("rejects 443 — production's tailscale port must never be touched", () => {
    expect(shouldReleaseTsPort(443)).toBe(false)
  })

  it('rejects undefined/null/0/NaN', () => {
    expect(shouldReleaseTsPort(undefined)).toBe(false)
    expect(shouldReleaseTsPort(null)).toBe(false)
    expect(shouldReleaseTsPort(0)).toBe(false)
    expect(shouldReleaseTsPort(NaN)).toBe(false)
  })

  it('accepts a numeric string, since the registry round-trips through JSON', () => {
    expect(shouldReleaseTsPort('8443')).toBe(true)
  })

  it('rejects "443" as a string too', () => {
    expect(shouldReleaseTsPort('443')).toBe(false)
  })
})

describe('releaseTsPort', () => {
  it('invokes the injected runner with --https=<tsPort> off for a normal port', () => {
    const run = vi.fn()
    const result = releaseTsPort(8443, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--https=8443', 'off'],
      expect.any(Object),
    )
    expect(result).toBe(8443)
  })

  it('never invokes the runner for tsPort 443', () => {
    const run = vi.fn()
    const result = releaseTsPort(443, run)
    expect(run).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('never invokes the runner for a missing/invalid tsPort', () => {
    const run = vi.fn()
    expect(releaseTsPort(undefined, run)).toBeNull()
    expect(releaseTsPort(null, run)).toBeNull()
    expect(releaseTsPort(0, run)).toBeNull()
    expect(releaseTsPort(NaN, run)).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('accepts a numeric-string tsPort and passes the coerced number through', () => {
    const run = vi.fn()
    const result = releaseTsPort('8443', run)
    expect(run).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--https=8443', 'off'],
      expect.any(Object),
    )
    expect(result).toBe(8443)
  })

  it('swallows a throwing runner — teardown must still succeed', () => {
    const run = vi.fn(() => {
      throw new Error('tailscale: command not found')
    })
    expect(() => releaseTsPort(8443, run)).not.toThrow()
    expect(releaseTsPort(8443, run)).toBe(8443)
  })
})

describe('pruneRegistry', () => {
  it('removes only slots whose root no longer exists', () => {
    const registry = {
      version: 1,
      slots: {
        gone: {
          slug: 'gone',
          root: '/repo/gone',
          port: 7431,
          tsPort: 8443,
          dataDir: '/x/gone',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        here: {
          slug: 'here',
          root: '/repo/here',
          port: 7432,
          tsPort: 8444,
          dataDir: '/x/here',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }

    const existsFn = (root) => root === '/repo/here'
    const { registry: pruned, removed } = pruneRegistry(registry, existsFn)

    expect(removed).toEqual(['gone'])
    expect(Object.keys(pruned.slots)).toEqual(['here'])
  })

  it('removes nothing and reports no removals when every root exists', () => {
    const registry = {
      version: 1,
      slots: {
        here: {
          slug: 'here',
          root: '/repo/here',
          port: 7432,
          tsPort: 8444,
          dataDir: '/x/here',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }

    const { registry: pruned, removed } = pruneRegistry(registry, () => true)

    expect(removed).toEqual([])
    expect(pruned).toEqual(registry)
  })
})
