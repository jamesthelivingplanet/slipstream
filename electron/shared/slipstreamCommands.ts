/**
 * slipstreamCommands — single source of truth for the `slipstream` CLI's
 * command surface, shared by the three places that document it to the agent:
 *
 *  - `electron/cli/slipstream.ts`        — the CLI's own `--help`/usage text
 *  - `electron/shared/cliSkillDoc.ts`    — the `slipstream` worktree skill (SKILL.md)
 *  - `electron/shared/promptComposer.ts` — the agent system prompt
 *
 * Before this module existed the same facts (the command list, which flags each
 * requires, the exit codes, the "state is reported ONLY through the CLI" claim)
 * were typed by hand into each file and drifted apart — e.g. the usage text said
 * exit 2 was "not in a Slipstream session" while the skill/runtime said "not
 * inside", and each file phrased the resume-from-waiting rule differently. Adding
 * or renaming a command meant editing three files and three test files in lockstep.
 *
 * Now the facts live here once; each surface *renders* from them. Adding a
 * command is a one-line edit to `SLIPSTREAM_COMMANDS` and every surface (and the
 * tests that iterate it) updates automatically. The persuasive, per-audience
 * *prose* (the system prompt's "do not investigate, do not reply" coaching; the
 * skill's lifecycle narrative) stays in its own file — only the factual surface
 * is unified, because that is what drifted.
 *
 * The runtime command handling (`runCli` in electron/cli/slipstream.ts) is
 * intentionally NOT driven from this spec: it is executable logic, not prose,
 * and binding it here would couple doc strings to control flow. Keep the spec
 * documentation-oriented.
 */

/** Numeric exit codes — the CLI's contract with callers and with the app. */
export const EXIT_OK = 0
export const EXIT_USAGE = 1
export const EXIT_NO_SESSION = 2
export const EXIT_FAILED = 3

/** Exit codes paired with their human labels, for rendering in help/skill text. */
export const EXIT_CODES = [
  { code: EXIT_OK, label: 'ok' },
  { code: EXIT_USAGE, label: 'usage error' },
  { code: EXIT_NO_SESSION, label: 'not inside a Slipstream session' },
  { code: EXIT_FAILED, label: 'operation failed' },
] as const

/**
 * The invariant substring of the "single channel" claim. Both the system prompt
 * and the skill doc weave this into their own sentences; asserting against this
 * constant (rather than a retyped copy) guarantees the two can't drift apart.
 */
export const SINGLE_CHANNEL_CLAIM = 'ONLY through the `slipstream` CLI'

export interface SlipstreamCommandSpec {
  /** Subcommand token(s) after `slipstream`, e.g. 'task-started', 'artifact publish'. */
  readonly command: string
  /** Full invocation for the reference table, e.g. 'slipstream artifact publish <file>'. */
  readonly invocation: string
  /** Usage synopsis (no binary prefix), e.g. 'task-started [--message <text>]'. */
  readonly synopsis: string
  /** Reference-table 'Required' cell (markdown), e.g. '`--message`' or '—'. */
  readonly requiredCell: string
  /** Reference-table 'Optional' cell (markdown), e.g. '`--message`' or '—'. */
  readonly optionalCell: string
  /** Canonical one-line effect, e.g. 'status → running'. */
  readonly effect: string
  /** Continuation line under the usage synopsis (no indent), when the synopsis wraps. */
  readonly usageCont?: string
  /** True for the five status-lifecycle commands (task-started … task-complete). */
  readonly lifecycle?: boolean
}

/**
 * The ordered command set. Order matters: the usage text and skill table both
 * present these in this order, and the lifecycle subset (the five status
 * commands) is grouped first because that is the order agents experience them.
 */
export const SLIPSTREAM_COMMANDS: readonly SlipstreamCommandSpec[] = [
  {
    command: 'task-started',
    invocation: 'slipstream task-started',
    synopsis: 'task-started [--message <text>]',
    requiredCell: '—',
    optionalCell: '`--message`',
    effect: 'status → running',
    lifecycle: true,
  },
  {
    command: 'request-input',
    invocation: 'slipstream request-input',
    synopsis: 'request-input --message <text>',
    requiredCell: '`--message`',
    optionalCell: '—',
    effect: 'status → waiting on user (input)',
    lifecycle: true,
  },
  {
    command: 'task-blocked',
    invocation: 'slipstream task-blocked',
    synopsis: 'task-blocked --message <text>',
    requiredCell: '`--message`',
    optionalCell: '—',
    effect: 'status → waiting on user (blocked)',
    lifecycle: true,
  },
  {
    command: 'approval-request',
    invocation: 'slipstream approval-request',
    synopsis: 'approval-request --message <text>',
    requiredCell: '`--message`',
    optionalCell: '—',
    effect: 'status → waiting on user (approval) + approval event',
    lifecycle: true,
  },
  {
    command: 'task-complete',
    invocation: 'slipstream task-complete',
    synopsis: 'task-complete --summary <text>',
    usageCont: '[--result success|partial|failure] [--details <text>]',
    requiredCell: '`--summary`',
    optionalCell: '`--result success|partial|failure`, `--details`',
    effect: 'records the durable outcome, then status → done',
    lifecycle: true,
  },
  {
    command: 'checkpoint',
    invocation: 'slipstream checkpoint',
    synopsis: 'checkpoint --message <text>',
    requiredCell: '`--message`',
    optionalCell: '—',
    effect: 'records a progress milestone',
  },
  {
    command: 'artifact publish',
    invocation: 'slipstream artifact publish <file>',
    synopsis: 'artifact publish <file> [--title <t>]',
    requiredCell: 'file path',
    optionalCell: '`--title`',
    effect: "copies the file into the session's artifact store",
  },
  {
    command: 'open-mr',
    invocation: 'slipstream open-mr',
    synopsis: 'open-mr --title <t> [--description <d>]',
    requiredCell: '`--title`',
    optionalCell: '`--description`',
    effect: 'pushes the branch (best-effort) and opens the merge/pull request',
  },
  {
    command: 'help',
    invocation: 'slipstream help [command]',
    synopsis: 'help [command]',
    requiredCell: '—',
    optionalCell: '—',
    effect: 'usage',
  },
]

/** The five status-lifecycle commands, in lifecycle order. */
export const LIFECYCLE_COMMANDS = SLIPSTREAM_COMMANDS.filter((c) => c.lifecycle)

/** Full invocations of the lifecycle commands, e.g. 'slipstream task-started'. */
export const LIFECYCLE_INVOCATIONS = LIFECYCLE_COMMANDS.map((c) => c.invocation)

/**
 * Render the indented, column-aligned command block used in `slipstream` usage
 * text. Synopses are padded to the widest first line so the effects line up;
 * wrapped continuation lines indent under the synopsis.
 */
export function renderUsageCommandBlock(): string {
  const width = Math.max(...SLIPSTREAM_COMMANDS.map((c) => c.synopsis.length))
  const lines: string[] = []
  for (const c of SLIPSTREAM_COMMANDS) {
    lines.push(`  ${c.synopsis.padEnd(width)}  ${c.effect}`)
    if (c.usageCont) lines.push(`      ${c.usageCont}`)
  }
  return lines.join('\n')
}

/** Render the markdown command-reference table used in the skill doc. */
export function renderCommandTable(): string {
  const header = '| Command | Required | Optional | Effect |\n|---|---|---|---|'
  const rows = SLIPSTREAM_COMMANDS.map(
    (c) => `| \`${c.invocation}\` | ${c.requiredCell} | ${c.optionalCell} | ${c.effect} |`,
  )
  return [header, ...rows].join('\n')
}

/** Render "0 ok<sep>1 usage error<sep>2 not inside a Slipstream session<sep>3 operation failed". */
export function renderExitCodes(separator: string): string {
  return EXIT_CODES.map((e) => `${e.code} ${e.label}`).join(separator)
}
