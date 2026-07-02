/**
 * runLogger unit tests — temp dir based, no native imports.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLogger } from './runLogger.js'
import { CLAUDE_BIN, CLAUDE_FLAGS } from '../shared/agentCli.js'

describe('createRunLogger', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slipstream-rl-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the logs/ dir on construction', () => {
    createRunLogger(root)
    expect(existsSync(join(root, 'logs'))).toBe(true)
  })

  describe('spawn', () => {
    it('writes a session log file with the spawn details', () => {
      const log = createRunLogger(root)
      const sid = '11111111-2222-3333-4444-555555555555'
      log.spawn(sid, {
        agentKind: 'claude-code',
        cmd: CLAUDE_BIN,
        args: [CLAUDE_FLAGS.skipPermissions, CLAUDE_FLAGS.sessionId, sid, 'do the thing'],
        cwd: '/tmp/repo',
        tid: 'FLO-1',
        title: 'Fix bug',
        prompt: 'Fix the bug in auth.ts',
      })
      const content = readFileSync(join(root, 'logs', `${sid}.log`), 'utf8')
      expect(content).toContain('SPAWN')
      expect(content).toContain(`session=${sid}`)
      expect(content).toContain('agentKind: claude-code')
      expect(content).toContain('cmd: claude')
      expect(content).toContain(CLAUDE_FLAGS.skipPermissions)
      expect(content).toContain('cwd: /tmp/repo')
      expect(content).toContain('tid: FLO-1')
      expect(content).toContain('title: Fix bug')
      expect(content).toContain('prompt: Fix the bug in auth.ts')
    })

    it('appends to the same session file on a second call', () => {
      const log = createRunLogger(root)
      const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      log.spawn(sid, { agentKind: 'opencode', cmd: 'opencode', args: [], cwd: '/tmp' })
      log.exit(sid, { exitCode: 0, status: 'done', tail: 'all good' })
      const content = readFileSync(join(root, 'logs', `${sid}.log`), 'utf8')
      expect(content).toContain('SPAWN')
      expect(content).toContain('EXIT')
      expect(content).toContain('all good')
    })

    it('never throws when the prompt is very long (truncates)', () => {
      const log = createRunLogger(root)
      const sid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
      const longPrompt = 'x'.repeat(1000)
      expect(() =>
        log.spawn(sid, {
          agentKind: 'claude-code',
          cmd: 'c',
          args: [],
          cwd: '/x',
          prompt: longPrompt,
        }),
      ).not.toThrow()
      const content = readFileSync(join(root, 'logs', `${sid}.log`), 'utf8')
      expect(content).toContain('[truncated]')
    })
  })

  describe('exit', () => {
    it('logs exit code, signal, status, and tail', () => {
      const log = createRunLogger(root)
      const sid = 'cccccccc-dddd-eeee-ffff-000000000000'
      log.exit(sid, { exitCode: 1, signal: 'SIGTERM', status: 'errored', tail: 'Error: boom' })
      const content = readFileSync(join(root, 'logs', `${sid}.log`), 'utf8')
      expect(content).toContain('EXIT')
      expect(content).toContain('code=1')
      expect(content).toContain('signal=SIGTERM')
      expect(content).toContain('status=errored')
      expect(content).toContain('Error: boom')
      expect(content).toContain('--- tail')
      expect(content).toContain('--- end tail')
    })

    it('truncates the tail to a reasonable size', () => {
      const log = createRunLogger(root)
      const sid = 'dddddddd-eeee-ffff-0000-111111111111'
      const tail = 'A'.repeat(10000)
      log.exit(sid, { exitCode: 0, status: 'done', tail })
      const content = readFileSync(join(root, 'logs', `${sid}.log`), 'utf8')
      // tail section should be bounded — the TAIL_CHARS constant caps it at 2048
      const tailSection = content.split('--- tail')[1]
      expect(tailSection.length).toBeLessThan(2600)
    })

    it('omits signal when it is 0/undefined', () => {
      const log = createRunLogger(root)
      const sid = 'eeeeeeee-ffff-0000-1111-222222222222'
      log.exit(sid, { exitCode: 0, status: 'done', tail: 'ok' })
      const content = readFileSync(join(root, 'logs', `${sid}.log`), 'utf8')
      expect(content).toContain('signal=null')
    })
  })

  describe('server', () => {
    it('appends timestamped lines to server.log', async () => {
      const log = createRunLogger(root)
      log.server('info', 'server starting', { pid: 123 })
      log.server('error', 'uncaughtException', new Error('boom'))
      // server.log uses async appendFile; wait for it to flush
      await new Promise((r) => setTimeout(r, 50))
      const content = readFileSync(join(root, 'logs', 'server.log'), 'utf8')
      expect(content).toContain('[info] server starting')
      expect(content).toContain('"pid":123')
      expect(content).toContain('[error] uncaughtException')
      expect(content).toContain('boom')
      // timestamps look ISO-ish
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })

    it('serializes Error objects with name/message/stack', async () => {
      const log = createRunLogger(root)
      const err = new TypeError('bad arg')
      log.server('error', 'rejection', err)
      await new Promise((r) => setTimeout(r, 50))
      const content = readFileSync(join(root, 'logs', 'server.log'), 'utf8')
      expect(content).toContain('"name":"TypeError"')
      expect(content).toContain('"message":"bad arg"')
    })
  })

  describe('robustness', () => {
    it('never throws on a spawn when the dir is fine (smoke)', () => {
      const log = createRunLogger(root)
      expect(() =>
        log.spawn('deadbeef-0000-0000-0000-000000000000', {
          agentKind: 'claude-code',
          cmd: 'c',
          args: ['--x'],
          cwd: '/x',
        }),
      ).not.toThrow()
    })
  })
})
