import { describe, it, expect } from 'vitest'
import { selectBackend, claudeCodeBackend, opencodeBackend, piBackend } from './agentBackend.js'

describe('selectBackend', () => {
  it('returns claudeCodeBackend for "claude-code"', () => {
    expect(selectBackend('claude-code')).toBe(claudeCodeBackend)
  })

  it('returns claudeCodeBackend for undefined (default)', () => {
    expect(selectBackend(undefined)).toBe(claudeCodeBackend)
  })

  it('returns opencodeBackend for "opencode"', () => {
    expect(selectBackend('opencode')).toBe(opencodeBackend)
  })

  it('returns piBackend for "pi"', () => {
    expect(selectBackend('pi')).toBe(piBackend)
  })
})

describe('statusSource', () => {
  it('claude-code uses pty', () => {
    expect(claudeCodeBackend.statusSource).toBe('pty')
  })

  it('opencode uses poll', () => {
    expect(opencodeBackend.statusSource).toBe('poll')
  })

  it('pi uses poll', () => {
    expect(piBackend.statusSource).toBe('poll')
  })
})

describe('claudeCodeBackend.buildStartArgs', () => {
  it('cmd is "claude"', () => {
    const { cmd } = claudeCodeBackend.buildStartArgs({
      sessionId: 'abc',
      system: '',
      user: 'do task',
    })
    expect(cmd).toBe('claude')
  })

  it('args include --dangerously-skip-permissions, --session-id, sessionId, and user prompt last', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid1',
      system: '',
      user: 'my task',
    })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--session-id')
    expect(args).toContain('sid1')
    expect(args[args.length - 1]).toBe('my task')
  })

  it('with non-empty system, args include --append-system-prompt followed by system text', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid2',
      system: 'sys prompt',
      user: 'task',
    })
    const idx = args.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('sys prompt')
  })

  it('with empty system, args do NOT include --append-system-prompt', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid3',
      system: '',
      user: 'task',
    })
    expect(args).not.toContain('--append-system-prompt')
  })

  it('with empty user prompt, args do NOT include the prompt (no trailing empty string)', () => {
    const { args } = claudeCodeBackend.buildStartArgs({
      sessionId: 'sid4',
      system: '',
      user: '',
    })
    expect(args).not.toContain('')
    expect(args[args.length - 1]).not.toBe('')
    // Should end with sessionId
    expect(args[args.length - 1]).toBe('sid4')
  })
})

describe('claudeCodeBackend.buildResumeArgs', () => {
  it('hasTranscript:true → args are [--dangerously-skip-permissions, --resume, id] only', () => {
    const { cmd, args } = claudeCodeBackend.buildResumeArgs({
      sessionId: 'myid',
      system: 'sys',
      user: 'task',
      hasTranscript: true,
    })
    expect(cmd).toBe('claude')
    expect(args).toEqual(['--dangerously-skip-permissions', '--resume', 'myid'])
  })

  it('hasTranscript:false → uses --session-id + prompt', () => {
    const { args } = claudeCodeBackend.buildResumeArgs({
      sessionId: 'myid2',
      system: '',
      user: 'my prompt',
      hasTranscript: false,
    })
    expect(args).toContain('--session-id')
    expect(args).toContain('myid2')
    expect(args[args.length - 1]).toBe('my prompt')
  })
})

describe('claudeCodeBackend.buildRemoteControlArgs', () => {
  it('includes --remote-control', () => {
    const { args } = claudeCodeBackend.buildRemoteControlArgs({
      sessionId: 'rcid',
      system: '',
      user: 'task',
      hasTranscript: false,
    })
    expect(args).toContain('--remote-control')
  })

  it('hasTranscript:true → uses --resume', () => {
    const { args } = claudeCodeBackend.buildRemoteControlArgs({
      sessionId: 'rcid2',
      system: '',
      user: 'task',
      hasTranscript: true,
    })
    expect(args).toContain('--remote-control')
    expect(args).toContain('--resume')
    expect(args).toContain('rcid2')
  })

  it('hasTranscript:false → uses --session-id', () => {
    const { args } = claudeCodeBackend.buildRemoteControlArgs({
      sessionId: 'rcid3',
      system: '',
      user: 'task',
      hasTranscript: false,
    })
    expect(args).toContain('--remote-control')
    expect(args).toContain('--session-id')
    expect(args).toContain('rcid3')
  })
})

describe('opencodeBackend.buildStartArgs', () => {
  it('includes --prompt with user text', () => {
    const { args } = opencodeBackend.buildStartArgs({
      sessionId: 'oc1',
      system: '',
      user: 'hello task',
      opencodePort: undefined,
    })
    const idx = args.indexOf('--prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('hello task')
  })

  it('includes --port with port string when opencodePort given', () => {
    const { args } = opencodeBackend.buildStartArgs({
      sessionId: 'oc2',
      system: '',
      user: 'task',
      opencodePort: 3333,
    })
    const idx = args.indexOf('--port')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('3333')
  })

  it('omits --port when opencodePort not given', () => {
    const { args } = opencodeBackend.buildStartArgs({ sessionId: 'oc3', system: '', user: 'task' })
    expect(args).not.toContain('--port')
  })
})

describe('opencodeBackend.buildResumeArgs', () => {
  it('with opencodeSid → includes ["--session", sid] and NO --prompt', () => {
    const { args } = opencodeBackend.buildResumeArgs({
      sessionId: 'oc4',
      system: '',
      user: 'task',
      hasTranscript: false,
      opencodeSid: 'my-oc-sid',
    })
    expect(args).toContain('--session')
    expect(args).toContain('my-oc-sid')
    expect(args).not.toContain('--prompt')
  })

  it('without opencodeSid → includes --continue', () => {
    const { args } = opencodeBackend.buildResumeArgs({
      sessionId: 'oc5',
      system: '',
      user: 'task',
      hasTranscript: false,
    })
    expect(args).toContain('--continue')
  })
})

describe('opencodeBackend.buildRemoteControlArgs', () => {
  it('behaves identically to buildResumeArgs: with sid → --session; without → --continue', () => {
    const withSid = opencodeBackend.buildRemoteControlArgs({
      sessionId: 'oc6',
      system: '',
      user: 'task',
      hasTranscript: false,
      opencodeSid: 'some-sid',
    })
    expect(withSid.args).toContain('--session')
    expect(withSid.args).toContain('some-sid')

    const withoutSid = opencodeBackend.buildRemoteControlArgs({
      sessionId: 'oc7',
      system: '',
      user: 'task',
      hasTranscript: false,
    })
    expect(withoutSid.args).toContain('--continue')
  })
})

describe('piBackend.buildStartArgs', () => {
  it('cmd ends with "pi"', () => {
    const { cmd } = piBackend.buildStartArgs({ sessionId: 'p1', system: '', user: 'task' })
    expect(cmd.endsWith('pi')).toBe(true)
  })

  it('args start with --approve and end with the user prompt', () => {
    const { args } = piBackend.buildStartArgs({ sessionId: 'p2', system: '', user: 'pi task' })
    expect(args[0]).toBe('--approve')
    expect(args[args.length - 1]).toBe('pi task')
  })

  it('with non-empty system, args include --append-system-prompt followed by system text', () => {
    const { args } = piBackend.buildStartArgs({ sessionId: 'p3', system: 'pi sys', user: 'task' })
    const idx = args.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('pi sys')
  })

  it('with empty user prompt, args do NOT include the prompt (no trailing empty string)', () => {
    const { args } = piBackend.buildStartArgs({ sessionId: 'p4', system: '', user: '' })
    expect(args).not.toContain('')
    expect(args[args.length - 1]).not.toBe('')
    // Should end with --approve (or system args if present)
    expect(args[args.length - 1]).toBe('--approve')
  })
})

describe('piBackend resume / remote-control', () => {
  it('buildResumeArgs is [--approve, --continue]', () => {
    const { args } = piBackend.buildResumeArgs({
      sessionId: 'p4',
      system: '',
      user: 'task',
      hasTranscript: false,
    })
    expect(args).toEqual(['--approve', '--continue'])
  })

  it('buildRemoteControlArgs is [--approve, --continue]', () => {
    const { args } = piBackend.buildRemoteControlArgs({
      sessionId: 'p5',
      system: '',
      user: 'task',
      hasTranscript: false,
    })
    expect(args).toEqual(['--approve', '--continue'])
  })
})

describe('claudeCodeBackend.buildHandoffArgs', () => {
  it('hasTranscript:false → uses --session-id + id + prompt is present', () => {
    const { cmd, args } = claudeCodeBackend.buildHandoffArgs({
      sessionId: 'hoid1',
      system: '',
      user: 'takeover prompt',
      hasTranscript: false,
    })
    expect(cmd).toBe('claude')
    expect(args).toContain('--session-id')
    expect(args).toContain('hoid1')
    expect(args[args.length - 1]).toBe('takeover prompt')
  })

  it('hasTranscript:true → uses --resume + id + the handoff prompt as the last arg; no --session-id', () => {
    const { args } = claudeCodeBackend.buildHandoffArgs({
      sessionId: 'hoid3',
      system: '',
      user: 'takeover prompt',
      hasTranscript: true,
    })
    expect(args).toContain('--resume')
    expect(args).toContain('hoid3')
    expect(args).not.toContain('--session-id')
    expect(args[args.length - 1]).toBe('takeover prompt')
  })
})

describe('opencodeBackend.buildHandoffArgs', () => {
  it('includes --prompt with the handoff text', () => {
    const { args } = opencodeBackend.buildHandoffArgs({
      sessionId: 'ohid1',
      system: '',
      user: 'takeover prompt',
      hasTranscript: false,
    })
    const idx = args.indexOf('--prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('takeover prompt')
  })

  it('includes --port with port string when opencodePort given', () => {
    const { args } = opencodeBackend.buildHandoffArgs({
      sessionId: 'ohid2',
      system: '',
      user: 'takeover prompt',
      hasTranscript: false,
      opencodePort: 4444,
    })
    const idx = args.indexOf('--port')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('4444')
  })
})

describe('piBackend.buildHandoffArgs', () => {
  it('cmd ends with "pi"', () => {
    const { cmd } = piBackend.buildHandoffArgs({
      sessionId: 'phid1',
      system: '',
      user: 'takeover prompt',
      hasTranscript: false,
    })
    expect(cmd.endsWith('pi')).toBe(true)
  })

  it('args contain --approve and end with the prompt', () => {
    const { args } = piBackend.buildHandoffArgs({
      sessionId: 'phid2',
      system: '',
      user: 'takeover prompt',
      hasTranscript: false,
    })
    expect(args).toContain('--approve')
    expect(args[args.length - 1]).toBe('takeover prompt')
  })

  it('with non-empty system, includes --append-system-prompt followed by system text', () => {
    const { args } = piBackend.buildHandoffArgs({
      sessionId: 'phid3',
      system: 'pi sys',
      user: 'takeover prompt',
      hasTranscript: false,
    })
    const idx = args.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('pi sys')
  })
})

describe('beginStatusTracking presence', () => {
  it('opencodeBackend.beginStatusTracking is a function', () => {
    expect(typeof opencodeBackend.beginStatusTracking).toBe('function')
  })

  it('piBackend.beginStatusTracking is a function', () => {
    expect(typeof piBackend.beginStatusTracking).toBe('function')
  })

  it('claudeCodeBackend.beginStatusTracking is undefined (PTY-driven)', () => {
    expect(claudeCodeBackend.beginStatusTracking).toBeUndefined()
  })
})

describe('prepareWorktree presence', () => {
  it('opencodeBackend.prepareWorktree is a function', () => {
    expect(typeof opencodeBackend.prepareWorktree).toBe('function')
  })

  it('claudeCodeBackend.prepareWorktree is undefined', () => {
    expect(claudeCodeBackend.prepareWorktree).toBeUndefined()
  })

  it('piBackend.prepareWorktree is undefined', () => {
    expect(piBackend.prepareWorktree).toBeUndefined()
  })
})
