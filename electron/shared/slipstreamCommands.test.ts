import { describe, it, expect } from 'vitest'
import {
  SLIPSTREAM_COMMANDS,
  LIFECYCLE_COMMANDS,
  LIFECYCLE_INVOCATIONS,
  EXIT_CODES,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_NO_SESSION,
  EXIT_FAILED,
  SINGLE_CHANNEL_CLAIM,
  renderUsageCommandBlock,
  renderCommandTable,
  renderExitCodes,
} from './slipstreamCommands.js'
import { buildSlipstreamSkillMd } from './cliSkillDoc.js'
import { buildSystemPrompt } from './promptComposer.js'

/**
 * The shared command spec is the whole point of FLO-137: the three doc surfaces
 * (CLI usage, skill md, system prompt) render from it so the factual surface
 * can't drift across them. These tests pin the spec's invariants and — most
 * importantly — the cross-surface agreement that previously had to be enforced
 * by hand across three files.
 */
describe('SLIPSTREAM_COMMANDS spec', () => {
  it('lists every command the CLI implements (no accidental adds/drops)', () => {
    expect(SLIPSTREAM_COMMANDS.map((c) => c.command)).toEqual([
      'task-started',
      'request-input',
      'task-blocked',
      'approval-request',
      'task-complete',
      'checkpoint',
      'artifact publish',
      'open-mr',
      'help',
    ])
  })

  it('has unique command, invocation, and synopsis tokens', () => {
    for (const field of ['command', 'invocation', 'synopsis'] as const) {
      const values = SLIPSTREAM_COMMANDS.map((c) => c[field])
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('every invocation is the binary prefix plus the command', () => {
    for (const c of SLIPSTREAM_COMMANDS) {
      expect(c.invocation.startsWith('slipstream ')).toBe(true)
    }
  })
})

describe('LIFECYCLE_COMMANDS', () => {
  it('is exactly the five status-lifecycle commands in lifecycle order', () => {
    expect(LIFECYCLE_COMMANDS.map((c) => c.command)).toEqual([
      'task-started',
      'request-input',
      'task-blocked',
      'approval-request',
      'task-complete',
    ])
  })

  it('LIFECYCLE_INVOCATIONS matches the lifecycle invocations', () => {
    expect(LIFECYCLE_INVOCATIONS).toEqual(LIFECYCLE_COMMANDS.map((c) => c.invocation))
  })
})

describe('EXIT_CODES', () => {
  it('covers 0..3 matching the named constants', () => {
    expect(EXIT_CODES.map((e) => e.code)).toEqual([
      EXIT_OK,
      EXIT_USAGE,
      EXIT_NO_SESSION,
      EXIT_FAILED,
    ])
    expect([EXIT_OK, EXIT_USAGE, EXIT_NO_SESSION, EXIT_FAILED]).toEqual([0, 1, 2, 3])
  })

  it('every label is non-empty', () => {
    for (const e of EXIT_CODES) expect(e.label.length).toBeGreaterThan(0)
  })

  it('uses the canonical "not inside a Slipstream session" wording (not "in")', () => {
    // Regression guard for the drift this module was created to fix: the CLI
    // usage text used to say "not in" while the skill/runtime said "not inside".
    expect(EXIT_CODES.some((e) => e.label === 'not inside a Slipstream session')).toBe(true)
  })
})

describe('SINGLE_CHANNEL_CLAIM', () => {
  it('is the invariant substring both prose surfaces weave into their sentences', () => {
    expect(SINGLE_CHANNEL_CLAIM).toBe('ONLY through the `slipstream` CLI')
  })
})

describe('renderUsageCommandBlock', () => {
  const block = renderUsageCommandBlock()

  it('includes every command synopsis and effect', () => {
    for (const c of SLIPSTREAM_COMMANDS) {
      expect(block).toContain(c.synopsis)
      expect(block).toContain(c.effect)
    }
  })

  it('includes the task-complete continuation line', () => {
    const tc = SLIPSTREAM_COMMANDS.find((c) => c.command === 'task-complete')!
    expect(tc.usageCont).toBeDefined()
    expect(block).toContain(tc.usageCont!)
  })

  it('column-aligns effects past the widest synopsis (≥2-space gap)', () => {
    const width = Math.max(...SLIPSTREAM_COMMANDS.map((c) => c.synopsis.length))
    for (const line of block.split('\n')) {
      // continuation lines start with 6 spaces and have no inline effect
      if (line.startsWith('      ')) continue
      const gapStart = line.indexOf('  ', 2 + width - 1)
      expect(gapStart).toBeGreaterThan(-1)
    }
  })
})

describe('renderCommandTable', () => {
  const table = renderCommandTable()

  it('has the markdown table header', () => {
    expect(table).toContain('| Command | Required | Optional | Effect |')
    expect(table).toContain('|---|---|---|---|')
  })

  it('includes a row for every command invocation and its effect', () => {
    for (const c of SLIPSTREAM_COMMANDS) {
      expect(table).toContain(`\`${c.invocation}\``)
      expect(table).toContain(c.effect)
    }
  })
})

describe('renderExitCodes', () => {
  it('joins "<code> <label>" with the given separator', () => {
    expect(renderExitCodes(', ')).toBe(
      '0 ok, 1 usage error, 2 not inside a Slipstream session, 3 operation failed',
    )
    expect(renderExitCodes(' · ')).toBe(
      '0 ok · 1 usage error · 2 not inside a Slipstream session · 3 operation failed',
    )
  })
})

/**
 * The cross-surface agreement — the guarantee that previously required editing
 * three files in lockstep. Each surface must reference the commands it claims
 * to document, derived from the one spec.
 */
describe('cross-surface agreement (the three surfaces render from the one spec)', () => {
  it('the skill doc mentions every command invocation', () => {
    const md = buildSlipstreamSkillMd()
    for (const c of SLIPSTREAM_COMMANDS) {
      expect(md).toContain(c.invocation)
    }
  })

  it('the skill doc weaves in the single-channel claim and the exit codes', () => {
    const md = buildSlipstreamSkillMd()
    expect(md).toContain(SINGLE_CHANNEL_CLAIM)
    expect(md).toContain(renderExitCodes(' · '))
  })

  it('the system prompt mentions every lifecycle invocation plus open-mr', () => {
    // The prompt intentionally documents only the lifecycle subset + the MR
    // step (not checkpoint/artifact/help), so it is checked for that subset.
    const prompt = buildSystemPrompt({ tid: 'T-1', title: 'Fix bug' })
    for (const invocation of LIFECYCLE_INVOCATIONS) {
      expect(prompt).toContain(invocation)
    }
    expect(prompt).toContain('slipstream open-mr')
    expect(prompt).toContain(SINGLE_CHANNEL_CLAIM)
  })
})
