import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { parseUsageCommands, checkSlipstreamCli, lastCliActivity } from './cliHealth.js'

describe('parseUsageCommands', () => {
  it('extracts command names from indented usage lines', () => {
    const usage = [
      'Usage: slipstream <command> [options]',
      '',
      '  task-started [--message <text>]        You started or resumed working.',
      '  request-input --message <text>         You stopped to wait.',
      '  artifact publish <file> [--title <t>]  Copy a file.',
      '  help [command]                         Show usage.',
      '',
      'Exit codes: 0 ok',
    ].join('\n')
    expect(parseUsageCommands(usage)).toEqual(['task-started', 'request-input', 'artifact', 'help'])
  })

  it('dedupes and ignores non-command lines', () => {
    expect(parseUsageCommands('  foo x\n  foo y\nbar\n    deep-indent')).toEqual(['foo'])
  })
})

describe('checkSlipstreamCli', () => {
  it('reports down with a spawn error for a missing binary', async () => {
    const res = await checkSlipstreamCli({
      electronPath: '/nonexistent/electron-binary',
      cliJsPath: '/nonexistent/cli.js',
      dataDir: '/tmp',
      timeoutMs: 2000,
    })
    expect(res.up).toBe(false)
    expect(res.commands).toEqual([])
    expect(res.error).toBeTruthy()
  })

  it('reports up when the CLI prints usage and exits 0 (node as stand-in runtime)', async () => {
    // `node <script> help` mirrors `electron <cli.js> help` closely enough:
    // the checker only asserts exit 0 + usage text on stdout.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-clihealth-'))
    const script = path.join(dir, 'fake-cli.js')
    fs.writeFileSync(
      script,
      `console.log('Usage: slipstream <command> [options]\\n\\n  task-started x\\n  open-mr y')`,
    )
    try {
      const res = await checkSlipstreamCli({
        electronPath: process.execPath,
        cliJsPath: script,
        dataDir: dir,
        timeoutMs: 4000,
      })
      expect(res.up).toBe(true)
      expect(res.commands).toEqual(['task-started', 'open-mr'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports down when the CLI exits non-zero', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-clihealth-'))
    const script = path.join(dir, 'broken-cli.js')
    fs.writeFileSync(script, `process.exit(3)`)
    try {
      const res = await checkSlipstreamCli({
        electronPath: process.execPath,
        cliJsPath: script,
        dataDir: dir,
        timeoutMs: 4000,
      })
      expect(res.up).toBe(false)
      expect(res.error).toContain('code=3')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('lastCliActivity', () => {
  it('returns the newest sentinel mtime including events.ndjson', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cliact-'))
    try {
      const sess = path.join(dir, 'sessions', 's1')
      fs.mkdirSync(sess, { recursive: true })
      fs.writeFileSync(path.join(sess, 'status.json'), '{}')
      fs.writeFileSync(path.join(sess, 'events.ndjson'), '')
      const old = Date.now() / 1000 - 3600
      fs.utimesSync(path.join(sess, 'status.json'), old, old)
      const newer = Date.now() / 1000
      fs.utimesSync(path.join(sess, 'events.ndjson'), newer, newer)

      const result = await lastCliActivity(dir)
      expect(result).toBeDefined()
      expect(result!).toBeGreaterThan((old + 10) * 1000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves undefined when there is no sessions dir', async () => {
    expect(await lastCliActivity('/nonexistent-root')).toBeUndefined()
  })
})
