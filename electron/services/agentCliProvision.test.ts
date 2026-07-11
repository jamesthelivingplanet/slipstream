import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  wrapperScript,
  provisionCliWrapper,
  buildCliSessionEnv,
  agentSessionEnv,
} from './agentCliProvision.js'
import { buildAgentEnv } from './agentEnv.js'

describe('wrapperScript', () => {
  it('is a POSIX sh script that execs the CLI under Electron-as-Node', () => {
    const script = wrapperScript('/usr/bin/electron', '/app/slipstream-cli.js')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('export ELECTRON_RUN_AS_NODE=1')
    expect(script).toContain('exec "/usr/bin/electron" "/app/slipstream-cli.js" "$@"')
  })
})

describe('provisionCliWrapper', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-prov-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes <binDir>/slipstream with mode 755', () => {
    const binDir = path.join(dir, 'bin')
    const wrapperPath = provisionCliWrapper({
      binDir,
      electronPath: '/usr/bin/electron',
      cliJsPath: '/app/slipstream-cli.js',
    })
    expect(wrapperPath).toBe(path.join(binDir, 'slipstream'))
    expect(fs.readFileSync(wrapperPath, 'utf8')).toContain('exec "/usr/bin/electron"')
    expect(fs.statSync(wrapperPath).mode & 0o777).toBe(0o755)
  })

  it('is idempotent and refreshes stale content', () => {
    const binDir = path.join(dir, 'bin')
    provisionCliWrapper({ binDir, electronPath: '/old', cliJsPath: '/old.js' })
    const wrapperPath = provisionCliWrapper({
      binDir,
      electronPath: '/new/electron',
      cliJsPath: '/new/cli.js',
    })
    expect(fs.readFileSync(wrapperPath, 'utf8')).toContain('/new/electron')
    expect(fs.statSync(wrapperPath).mode & 0o777).toBe(0o755)
  })
})

describe('buildCliSessionEnv', () => {
  const params = {
    dataDir: '/data',
    sessionId: 's1',
    base: 'main',
    branch: 'feat',
    binDir: '/data/bin',
    basePath: '/usr/bin:/bin',
  }

  it('returns the four identity vars plus a PATH with the wrapper dir prepended', () => {
    expect(buildCliSessionEnv(params)).toEqual({
      SLIPSTREAM_DATA_DIR: '/data',
      SLIPSTREAM_SESSION_ID: 's1',
      SLIPSTREAM_BASE: 'main',
      SLIPSTREAM_BRANCH: 'feat',
      PATH: '/data/bin:/usr/bin:/bin',
    })
  })

  it('handles an empty base PATH', () => {
    expect(buildCliSessionEnv({ ...params, basePath: '' }).PATH).toBe('/data/bin')
  })

  it('never contains a key the agent-env scrubber removes', () => {
    const env = buildCliSessionEnv(params)
    // Round-trip through the actual scrubber: everything set here must survive,
    // proving no daemon-internal key is smuggled into the agent env.
    const scrubbed = buildAgentEnv({}, env)
    expect(scrubbed).toEqual(env)
  })
})

describe('agentSessionEnv', () => {
  const agentCli = {
    binDir: '/data/bin',
    cliJsPath: '/app/cli.js',
    electronPath: '/usr/bin/electron',
    dataDir: '/data',
  }

  it('merges PORT with the CLI env', () => {
    const env = agentSessionEnv(agentCli, {
      sessionId: 's1',
      base: 'main',
      branch: 'b',
      port: 4100,
    })
    expect(env?.PORT).toBe('4100')
    expect(env?.SLIPSTREAM_SESSION_ID).toBe('s1')
    expect(env?.PATH?.startsWith('/data/bin:')).toBe(true)
  })

  it('omits PORT when no port was claimed', () => {
    const env = agentSessionEnv(agentCli, { sessionId: 's1', base: 'main', branch: 'b' })
    expect(env).not.toHaveProperty('PORT')
    expect(env?.SLIPSTREAM_BRANCH).toBe('b')
  })

  it('returns undefined when agentCli is absent and there is no port (test fallback)', () => {
    expect(
      agentSessionEnv(undefined, { sessionId: 's1', base: 'main', branch: 'b' }),
    ).toBeUndefined()
  })

  it('returns just PORT when agentCli is absent', () => {
    expect(
      agentSessionEnv(undefined, { sessionId: 's1', base: 'main', branch: 'b', port: 1 }),
    ).toEqual({ PORT: '1' })
  })
})
