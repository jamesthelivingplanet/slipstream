import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveDevDataDir, prodDataDirDefault } from './devDataDir.mjs'
import { DEV_DATA_ROOT, slugForRoot } from './devSlots.mjs'

const HOMEDIR = '/home/agent'
const ROOT = '/home/agent/.worktrees/some-project/TASK-ABC'
const SLUG = slugForRoot(ROOT)
const WORKTREE_DEV_DIR = path.join(DEV_DATA_ROOT, SLUG)

function baseArgs(overrides = {}) {
  return {
    env: {},
    isLinkedWorktree: true,
    root: ROOT,
    registry: { version: 1, slots: {} },
    platform: 'linux',
    homedir: HOMEDIR,
    ...overrides,
  }
}

describe('prodDataDirDefault', () => {
  it('linux default is $XDG_CONFIG_HOME/slipstream', () => {
    expect(
      prodDataDirDefault({
        env: { XDG_CONFIG_HOME: '/x/config' },
        platform: 'linux',
        homedir: HOMEDIR,
      }),
    ).toBe(path.join('/x/config', 'slipstream'))
  })

  it('linux default falls back to ~/.config/slipstream when XDG_CONFIG_HOME unset', () => {
    expect(prodDataDirDefault({ env: {}, platform: 'linux', homedir: HOMEDIR })).toBe(
      path.join(HOMEDIR, '.config', 'slipstream'),
    )
  })

  it('darwin default is ~/Library/Application Support/slipstream', () => {
    expect(prodDataDirDefault({ env: {}, platform: 'darwin', homedir: HOMEDIR })).toBe(
      path.join(HOMEDIR, 'Library', 'Application Support', 'slipstream'),
    )
  })

  it('win32 default uses %APPDATA%/slipstream', () => {
    expect(
      prodDataDirDefault({
        env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
        platform: 'win32',
        homedir: HOMEDIR,
      }),
    ).toBe(path.join('C:\\Users\\a\\AppData\\Roaming', 'slipstream'))
  })
})

describe('resolveDevDataDir — linked worktree', () => {
  it('REGRESSION: SLIPSTREAM_DATA_DIR inherited as the prod data dir is overridden with the worktree dev dir', () => {
    const prodDir = path.join(HOMEDIR, '.config', 'slipstream')
    const result = resolveDevDataDir(baseArgs({ env: { SLIPSTREAM_DATA_DIR: prodDir } }))
    expect(result.dataDir).toBe(WORKTREE_DEV_DIR)
    expect(result.reason).toMatch(/overrid/i)
  })

  it('SLIPSTREAM_DATA_DIR unset resolves to the worktree dev data dir', () => {
    const result = resolveDevDataDir(baseArgs({ env: {} }))
    expect(result.dataDir).toBe(WORKTREE_DEV_DIR)
  })

  it('SLIPSTREAM_DATA_DIR set to an unrelated dir is respected', () => {
    const result = resolveDevDataDir(baseArgs({ env: { SLIPSTREAM_DATA_DIR: '/tmp/explicit' } }))
    expect(result.dataDir).toBe('/tmp/explicit')
    expect(result.reason).toBe('explicit env')
  })

  it('a registered slot in the registry is used', () => {
    const registeredDataDir = '/custom/slot/data'
    const registry = { version: 1, slots: { [SLUG]: { root: ROOT, dataDir: registeredDataDir } } }
    const result = resolveDevDataDir(baseArgs({ env: {}, registry }))
    expect(result.dataDir).toBe(registeredDataDir)
    expect(result.reason).toMatch(/registered dev slot/)
  })

  it('SLIPSTREAM_DATA_DIR pointing INSIDE the prod data dir is overridden', () => {
    const insideProd = path.join(HOMEDIR, '.config', 'slipstream', 'nested', 'dir')
    const result = resolveDevDataDir(baseArgs({ env: { SLIPSTREAM_DATA_DIR: insideProd } }))
    expect(result.dataDir).toBe(WORKTREE_DEV_DIR)
    expect(result.reason).toMatch(/overrid/i)
  })

  it('SLIPSTREAM_PROD_DATA_DIR overrides the platform default as the prod data dir to compare against', () => {
    const customProdDir = '/mnt/custom-prod-data'
    const result = resolveDevDataDir(
      baseArgs({
        env: { SLIPSTREAM_DATA_DIR: customProdDir, SLIPSTREAM_PROD_DATA_DIR: customProdDir },
      }),
    )
    expect(result.dataDir).toBe(WORKTREE_DEV_DIR)
    expect(result.reason).toMatch(/overrid/i)
  })

  it('SLIPSTREAM_PROD_DATA_DIR set: a value outside it (but equal to the platform default) is respected as a deliberate override', () => {
    const customProdDir = '/mnt/custom-prod-data'
    const platformDefaultDir = path.join(HOMEDIR, '.config', 'slipstream')
    const result = resolveDevDataDir(
      baseArgs({
        env: { SLIPSTREAM_DATA_DIR: platformDefaultDir, SLIPSTREAM_PROD_DATA_DIR: customProdDir },
      }),
    )
    expect(result.dataDir).toBe(platformDefaultDir)
    expect(result.reason).toBe('explicit env')
  })
})

describe('resolveDevDataDir — main worktree', () => {
  it('SLIPSTREAM_DATA_DIR set is respected unchanged', () => {
    const result = resolveDevDataDir(
      baseArgs({ isLinkedWorktree: false, env: { SLIPSTREAM_DATA_DIR: '/anything/at/all' } }),
    )
    expect(result.dataDir).toBe('/anything/at/all')
    expect(result.reason).toBe('explicit env')
  })

  it('SLIPSTREAM_DATA_DIR unset leaves dataDir undefined so the prod default applies', () => {
    const result = resolveDevDataDir(baseArgs({ isLinkedWorktree: false, env: {} }))
    expect(result.dataDir).toBeUndefined()
  })
})

describe('resolveDevDataDir — linked worktree without a resolvable root', () => {
  it('leaves dataDir undefined rather than guessing', () => {
    const result = resolveDevDataDir(baseArgs({ root: undefined }))
    expect(result.dataDir).toBeUndefined()
  })
})
