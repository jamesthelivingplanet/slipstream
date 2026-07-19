import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  wrapperScript,
  provisionCliWrapper,
  buildCliSessionEnv,
  agentSessionEnv,
  provisionClipboardShims,
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
    // proving no daemon-internal key is smuggled into the agent env. The scrubber
    // may still add its own keys (e.g. DISPLAY on headless hosts), so this only
    // asserts on `env`'s keys rather than requiring exact equality.
    const scrubbed = buildAgentEnv({}, env)
    expect(scrubbed).toMatchObject(env)
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

/** Extracts the base64 payload from an OSC 52 "set clipboard" escape
 *  sequence (`\x1b]52;c;<b64>\x07`) and decodes it back to the original
 *  text, for asserting on what a write-mode shim emitted. Uses plain
 *  string scanning (not a regex literal) to avoid embedding raw control
 *  characters in a regex pattern. */
function decodeOsc52(content: string): string {
  const intro = '\x1b]52;c;'
  const start = content.indexOf(intro)
  if (start === -1) throw new Error(`no OSC 52 sequence found in: ${JSON.stringify(content)}`)
  const end = content.indexOf('\x07', start)
  if (end === -1) throw new Error(`unterminated OSC 52 sequence in: ${JSON.stringify(content)}`)
  const b64 = content.slice(start + intro.length, end)
  return Buffer.from(b64, 'base64').toString('utf8')
}

describe('provisionClipboardShims', () => {
  let dir: string
  let binDir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-prov-'))
    binDir = path.join(dir, 'bin')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes all six shims into binDir, each executable', () => {
    const paths = provisionClipboardShims(binDir)
    const names = ['xclip', 'xsel', 'wl-copy', 'wl-paste', 'pbcopy', 'pbpaste']
    expect(paths).toEqual(names.map((n) => path.join(binDir, n)))
    for (const p of paths) {
      expect(fs.statSync(p).mode & 0o777).toBe(0o755)
    }
  })

  it('xclip with no args (write mode) emits stdin as an OSC 52 sequence', () => {
    provisionClipboardShims(binDir)
    const ttyOverride = path.join(dir, 'fake-tty')
    fs.writeFileSync(ttyOverride, '')
    const text = 'hello clipboard'
    execFileSync('sh', [path.join(binDir, 'xclip')], {
      input: text,
      env: { ...process.env, SLIPSTREAM_TTY_OVERRIDE: ttyOverride },
    })
    expect(decodeOsc52(fs.readFileSync(ttyOverride, 'utf8'))).toBe(text)
  })

  it('wl-copy (always write) emits stdin as an OSC 52 sequence', () => {
    provisionClipboardShims(binDir)
    const ttyOverride = path.join(dir, 'fake-tty')
    fs.writeFileSync(ttyOverride, '')
    const text = 'wl-copy payload'
    execFileSync('sh', [path.join(binDir, 'wl-copy')], {
      input: text,
      env: { ...process.env, SLIPSTREAM_TTY_OVERRIDE: ttyOverride },
    })
    expect(decodeOsc52(fs.readFileSync(ttyOverride, 'utf8'))).toBe(text)
  })

  it('xclip -o -t image/png returns the cached clipboard image when present', () => {
    provisionClipboardShims(binDir)
    const dataDir = path.join(dir, 'data')
    const sessionId = 'sess-1'
    fs.mkdirSync(path.join(dataDir, 'clipboard'), { recursive: true })
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03])
    fs.writeFileSync(path.join(dataDir, 'clipboard', `${sessionId}.png`), pngBytes)

    const out = execFileSync('sh', [path.join(binDir, 'xclip'), '-o', '-t', 'image/png'], {
      env: {
        ...process.env,
        SLIPSTREAM_DATA_DIR: dataDir,
        SLIPSTREAM_SESSION_ID: sessionId,
      },
    })
    expect(Buffer.compare(out, pngBytes)).toBe(0)
  })

  it('wl-paste --type image/png returns the cached clipboard image when present', () => {
    provisionClipboardShims(binDir)
    const dataDir = path.join(dir, 'data')
    const sessionId = 'sess-2'
    fs.mkdirSync(path.join(dataDir, 'clipboard'), { recursive: true })
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0b])
    fs.writeFileSync(path.join(dataDir, 'clipboard', `${sessionId}.png`), pngBytes)

    const out = execFileSync('sh', [path.join(binDir, 'wl-paste'), '--type', 'image/png'], {
      env: {
        ...process.env,
        SLIPSTREAM_DATA_DIR: dataDir,
        SLIPSTREAM_SESSION_ID: sessionId,
      },
    })
    expect(Buffer.compare(out, pngBytes)).toBe(0)
  })

  it('xclip -o -t image/png prints nothing and exits 0 when no cached image exists', () => {
    provisionClipboardShims(binDir)
    const dataDir = path.join(dir, 'data-empty')
    const result = execFileSync('sh', [path.join(binDir, 'xclip'), '-o', '-t', 'image/png'], {
      env: {
        ...process.env,
        SLIPSTREAM_DATA_DIR: dataDir,
        SLIPSTREAM_SESSION_ID: 'no-such-session',
      },
    })
    expect(result.length).toBe(0)
  })

  it('pbpaste always prints nothing and exits 0, even with a cached image present', () => {
    provisionClipboardShims(binDir)
    const dataDir = path.join(dir, 'data')
    const sessionId = 'sess-3'
    fs.mkdirSync(path.join(dataDir, 'clipboard'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'clipboard', `${sessionId}.png`), Buffer.from([1, 2, 3]))

    const result = execFileSync('sh', [path.join(binDir, 'pbpaste')], {
      env: {
        ...process.env,
        SLIPSTREAM_DATA_DIR: dataDir,
        SLIPSTREAM_SESSION_ID: sessionId,
      },
    })
    expect(result.length).toBe(0)
  })

  it('xclip -t TARGETS prints image/png when a cached image is present', () => {
    provisionClipboardShims(binDir)
    const dataDir = path.join(dir, 'data')
    const sessionId = 'sess-4'
    fs.mkdirSync(path.join(dataDir, 'clipboard'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'clipboard', `${sessionId}.png`), Buffer.from([1, 2, 3]))

    const out = execFileSync('sh', [path.join(binDir, 'xclip'), '-o', '-t', 'TARGETS'], {
      env: {
        ...process.env,
        SLIPSTREAM_DATA_DIR: dataDir,
        SLIPSTREAM_SESSION_ID: sessionId,
      },
    })
    expect(out.toString('utf8')).toBe('image/png\n')
  })

  it('wl-paste --list-types prints image/png when a cached image is present', () => {
    provisionClipboardShims(binDir)
    const dataDir = path.join(dir, 'data')
    const sessionId = 'sess-5'
    fs.mkdirSync(path.join(dataDir, 'clipboard'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'clipboard', `${sessionId}.png`), Buffer.from([1, 2, 3]))

    const out = execFileSync('sh', [path.join(binDir, 'wl-paste'), '--list-types'], {
      env: {
        ...process.env,
        SLIPSTREAM_DATA_DIR: dataDir,
        SLIPSTREAM_SESSION_ID: sessionId,
      },
    })
    expect(out.toString('utf8')).toBe('image/png\n')
  })

  it('never exits nonzero on an unrecognized/bogus flag', () => {
    provisionClipboardShims(binDir)
    for (const [tool, args] of [
      ['xclip', ['--bogus-flag', '-selection', 'clipboard', '-b']],
      ['xsel', ['-n', '--weird']],
      ['wl-copy', ['--type=text/plain', '--foreign-selection']],
      ['wl-paste', ['--no-newline', '--seat', 'whatever']],
      ['pbcopy', ['--nonsense']],
      ['pbpaste', ['--nonsense']],
    ] as const) {
      const result = spawnSync('sh', [path.join(binDir, tool), ...args], {
        input: 'irrelevant stdin',
        env: { ...process.env, SLIPSTREAM_TTY_OVERRIDE: path.join(dir, 'discard-tty') },
      })
      expect(result.status).toBe(0)
    }
  })
})
