/**
 * Pure logic for the PreToolUse "no touching prod from a linked worktree"
 * guard (see scripts/guard-prod.mjs for the executable wrapper that reads
 * the hook payload and calls into this module).
 *
 * Scope: this only ever runs when `ctx.isLinkedWorktree` is true — the main
 * checkout is unrestricted, because that's where `pnpm deploy --target=prod`
 * is meant to run from. Everything below asks "does this segment of a bash
 * command touch the systemd prod unit, tailscale's public port 443, the prod
 * data dir, the prod checkout, or `pnpm deploy --target=prod`?".
 *
 * FALSE NEGATIVES > FALSE POSITIVES. This is a best-effort textual guard, not
 * a shell parser — it does not understand subshells, `eval`, base64-encoded
 * payloads, weird quoting, or a dozen other ways a determined command could
 * dodge it. That's an accepted gap: this hook exists to catch ordinary
 * mistakes and lazy shortcuts, not a hostile agent. Given that, every rule
 * below (especially the path/redirection matching in `isProdPath`) is
 * written to require a fairly literal, recognizable match before denying —
 * a wrongly-blocked `grep`/`cat`/`git` command that stalls the agent on a
 * false alarm is worse than a missed exotic bypass, because the false alarm
 * has to be resolved by a human anyway (the hook can't ask a follow-up
 * question), while the missed bypass is still just one bug report away from
 * getting tightened.
 *
 * Write-command argument checking (`checkWriteAndRedirect`) is POSITIONAL
 * per command, not "deny if any argument is a prod path". `cp`/`install`
 * only mutate their destination — treating every argument (including a
 * prod *source* being read) as a potential write was itself a false
 * positive (e.g. `cp ~/.config/slipstream/server.env /tmp/backup` was
 * denied even though it never touches prod). `dd` is the same idea via
 * `if=`/`of=` operands: only `of=` writes. `mv`/`ln` differ on purpose and
 * still check every argument — see the comments at each check for why.
 *
 * Heredoc bodies are stripped before any of the above runs (see
 * `stripHeredocs`). A heredoc body is arbitrary free text — e.g. a commit
 * message piped via `git commit -F - <<'EOF' ... EOF` — and splitting it
 * into segments on newlines would parse a body line that merely *mentions*
 * `SLIPSTREAM_TARGET=prod` (or any other trigger string) as if it were a
 * real leading env assignment or command. That's exactly the false-positive
 * this module is biased against, so heredoc bodies are dropped up front;
 * only the line that opens the heredoc (the real command) is still
 * evaluated.
 */

const MUTATING_SYSTEMCTL_VERBS = new Set([
  'start',
  'stop',
  'restart',
  'try-restart',
  'reload',
  'reload-or-restart',
  'kill',
  'enable',
  'disable',
  'mask',
  'unmask',
  'edit',
  'set-property',
])

const READONLY_SYSTEMCTL_VERBS = new Set([
  'status',
  'is-active',
  'is-enabled',
  'show',
  'cat',
  'list-units',
  'list-unit-files',
  'daemon-reload',
])

const PROD_UNIT_NAMES = new Set(['slipstream', 'slipstream.service', 'slipstream.target'])

const WRITE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'install',
  'truncate',
  'tee',
  'dd',
  'chmod',
  'chown',
  'ln',
  'touch',
  'mkdir',
  'sqlite3',
  'sed',
])

const DEPLOY_TOOLS = new Set(['pnpm', 'npm', 'yarn'])

const WORKTREE_NOTE =
  'linked worktrees deploy to dev only — `pnpm deploy` from this worktree targets dev ' +
  'automatically; to touch prod, do it from the main checkout at ~/.repositories/slipstream.'

function deny(what) {
  return { reason: `Blocked: ${what} ${WORKTREE_NOTE}` }
}

/**
 * Matches a heredoc-opening operator (`<<` or `<<-`, never `<<<` — that's a
 * herestring with no body) plus its delimiter word, in one of three shapes:
 * single-quoted (`'EOF'`), double-quoted (`"EOF"`), or bare/backslash-escaped
 * (`EOF`, `\EOF`). Capture groups: 1 = `-` flag, 2/3/4 = delimiter text per
 * shape.
 */
const HEREDOC_OPERATOR_RE = /<<(-)?(?!<)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s'"<>|&;]+))/g

/**
 * Strip heredoc bodies out of a raw command string before it's split into
 * segments. The line that opens a heredoc (containing the `<<`/`<<-`
 * operator) is kept as-is — it's still a real command invocation, e.g. `tee
 * ~/.config/slipstream/server.env <<EOF` must still be evaluated. Every
 * following line is dropped until (and including) the line whose content
 * — trimmed, for `<<-` — equals the delimiter. Supports multiple heredocs
 * opened on one line (bodies consumed in order) and falls off the end of
 * input harmlessly if a heredoc is never terminated.
 */
function stripHeredocs(command) {
  const lines = command.split('\n')
  const kept = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    kept.push(line)
    i++

    const delimiters = []
    HEREDOC_OPERATOR_RE.lastIndex = 0
    let match
    while ((match = HEREDOC_OPERATOR_RE.exec(line)) !== null) {
      const dashFlag = match[1] === '-'
      const rawDelim = match[2] ?? match[3] ?? match[4]
      if (!rawDelim) continue
      const delim = match[4] ? rawDelim.replace(/\\/g, '') : rawDelim
      delimiters.push({ delim, dashFlag })
    }

    for (const { delim, dashFlag } of delimiters) {
      while (i < lines.length) {
        const bodyLine = lines[i]
        i++
        const compare = dashFlag ? bodyLine.trim() : bodyLine
        if (compare === delim) break
      }
    }
  }
  return kept.join('\n')
}

/**
 * Split a full command string into independently-evaluated segments on
 * `;`, `&&`, `||`, `|`, and newlines. Longest operators first so `||`/`&&`
 * aren't sliced as two `|`/two bare tokens.
 */
function splitSegments(command) {
  return command.split(/\|\||&&|;|\n|\|/)
}

/**
 * Minimal shell-ish tokenizer: whitespace-separated, with single/double
 * quoted spans kept whole (quotes stripped). Good enough for pulling out
 * the invoked command and its argv; not a full shell grammar.
 */
function tokenize(segment) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * Walk past leading env-var assignments (`FOO=bar cmd`) and leading
 * `sudo`/`env` wrappers to find the command that's actually invoked, e.g.
 * `sudo SLIPSTREAM_TARGET=prod systemctl ...` -> cmd `systemctl`.
 */
function getInvokedCommand(tokens) {
  const leadingEnv = new Map()
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    const envMatch = ENV_ASSIGNMENT_RE.exec(t)
    if (envMatch) {
      leadingEnv.set(envMatch[1], envMatch[2])
      i++
      continue
    }
    if (t === 'sudo' || t === 'env') {
      i++
      continue
    }
    break
  }
  const raw = tokens[i]
  const cmd = raw ? raw.split('/').pop() : undefined
  const rest = tokens.slice(i + 1)
  return { cmd, rest, leadingEnv }
}

function resolveHome(p, home) {
  if (!home) return p
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p.replace(/\$\{HOME\}/g, home).replace(/\$HOME\b/g, home)
}

/**
 * Is `p` (a raw path-ish token from the command) inside the prod data dir
 * or the prod checkout — but NOT inside the dev-slots carve-out, which is
 * dev state and must stay writable from a worktree.
 */
function isProdPath(p, home) {
  if (!home) return false
  const resolved = resolveHome(p, home)
  const devSlotsDir = `${home}/.config/slipstream/dev-slots`
  const devSlotsJson = `${home}/.config/slipstream/dev-slots.json`
  if (
    resolved === devSlotsJson ||
    resolved === devSlotsDir ||
    resolved.startsWith(`${devSlotsDir}/`)
  ) {
    return false
  }
  const prodDataDir = `${home}/.config/slipstream`
  const prodCheckout = `${home}/.repositories/slipstream`
  if (resolved === prodDataDir || resolved.startsWith(`${prodDataDir}/`)) return true
  if (resolved === prodCheckout || resolved.startsWith(`${prodCheckout}/`)) return true
  return false
}

function checkSystemctl(rest) {
  // Find the first non-flag token that's a recognized verb.
  const verb = rest.find(
    (t) =>
      !t.startsWith('-') && (MUTATING_SYSTEMCTL_VERBS.has(t) || READONLY_SYSTEMCTL_VERBS.has(t)),
  )
  if (!verb || READONLY_SYSTEMCTL_VERBS.has(verb)) return null
  if (!MUTATING_SYSTEMCTL_VERBS.has(verb)) return null
  // Check for a prod unit FIRST — a command that lists a prod unit alongside
  // a dev unit (e.g. `systemctl ... stop slipstream.service
  // slipstream-dev@x.service`) must still be denied; a dev unit's presence
  // does not excuse a prod unit also being targeted.
  const hasProdUnit = rest.some((t) => PROD_UNIT_NAMES.has(t))
  if (hasProdUnit) {
    return deny(`\`systemctl ... ${verb} <prod unit>\` targets the production slipstream.service.`)
  }
  return null
}

function checkTailscale(rest) {
  const sub = rest.find((t) => !t.startsWith('-'))
  if (sub !== 'serve' && sub !== 'funnel') return null
  // \b443\b (not a bare substring test) so `--https=8443` doesn't false-positive on `443`.
  const has443 = rest.some((t) => /\b443\b/.test(t))
  if (has443) {
    return deny(`\`tailscale ${sub}\` on port 443 changes the public prod endpoint.`)
  }
  const subIndex = rest.indexOf(sub)
  const next = rest[subIndex + 1]
  if (next === 'reset' || next === 'off') {
    const hasPortScoping = rest.some(
      (t, idx) => idx !== subIndex && idx !== subIndex + 1 && /\d/.test(t),
    )
    if (!hasPortScoping) {
      return deny(
        `\`tailscale ${sub} ${next}\` with no port scoping tears down the prod serve/funnel config.`,
      )
    }
  }
  return null
}

function extractRedirectionTargets(segment) {
  const targets = []
  const re = /(?:^|\s)[12&]?>>?\s*(\S+)/g
  let match
  while ((match = re.exec(segment)) !== null) {
    targets.push(match[1].replace(/^["']|["']$/g, ''))
  }
  return targets
}

/**
 * Value of a `cp`/`install`/`mv` `-t`/`--target-directory` option — the
 * alternate way of specifying the destination directory, which relocates
 * it out of its usual "last argument" position (everything else becomes a
 * source). Handles `-t VALUE`, `--target-directory VALUE`, and
 * `--target-directory=VALUE`. Returns undefined if the option isn't present.
 */
function findTargetDirOption(rest) {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '-t' || t === '--target-directory') return rest[i + 1]
    if (t.startsWith('--target-directory=')) return t.slice('--target-directory='.length)
  }
  return undefined
}

function findLastNonFlag(rest) {
  const nonFlags = rest.filter((t) => !t.startsWith('-'))
  return nonFlags.length > 0 ? nonFlags[nonFlags.length - 1] : undefined
}

/**
 * cp/install only mutate their DESTINATION — every other argument is a
 * source being read, not written. The destination is ordinarily the last
 * non-flag argument, but `-t DIR`/`--target-directory=DIR` relocates it
 * into an option value instead, so that takes priority when present.
 */
function checkCpOrInstallWrite(cmd, rest, home) {
  const targetDir = findTargetDirOption(rest)
  const destination = targetDir !== undefined ? targetDir : findLastNonFlag(rest)
  if (destination !== undefined && isProdPath(destination, home)) {
    return deny(`\`${cmd}\` targeting \`${destination}\` writes to the prod data dir/checkout.`)
  }
  return null
}

/**
 * dd addresses its files via `if=`/`of=` operands, not bare positional
 * args — only `of=` (output file) writes; `if=` (input file) is a read.
 * If neither form is present (an invocation shape we don't recognize),
 * fall back to the conservative all-argument check every other write
 * command uses, per this module's false-negatives-over-false-positives bias.
 */
function checkDdWrite(rest, home) {
  let hasIfOrOf = false
  for (const token of rest) {
    if (token.startsWith('of=')) {
      hasIfOrOf = true
      const target = token.slice('of='.length)
      if (isProdPath(target, home)) {
        return deny(`\`dd\` writing to \`${token}\` writes to the prod data dir/checkout.`)
      }
    } else if (token.startsWith('if=')) {
      hasIfOrOf = true
    }
  }
  if (hasIfOrOf) return null

  for (const token of rest) {
    if (token.startsWith('-')) continue
    if (isProdPath(token, home)) {
      return deny(`\`dd\` targeting \`${token}\` writes to the prod data dir/checkout.`)
    }
  }
  return null
}

function checkWriteAndRedirect(segment, cmd, rest, home) {
  const redirectTargets = extractRedirectionTargets(segment)
  for (const target of redirectTargets) {
    if (isProdPath(target, home)) {
      return deny(`shell redirection into \`${target}\` writes to the prod data dir/checkout.`)
    }
  }

  if (!cmd || !WRITE_COMMANDS.has(cmd)) return null

  if (cmd === 'sed') {
    const hasInPlace = rest.some((t) => t === '-i' || /^-i\S/.test(t) || t === '--in-place')
    if (!hasInPlace) return null
  }

  if (cmd === 'cp' || cmd === 'install') {
    return checkCpOrInstallWrite(cmd, rest, home)
  }

  if (cmd === 'dd') {
    return checkDdWrite(rest, home)
  }

  // mv and ln are NOT like cp/install: every argument can mutate prod, not
  // just one. mv's source stops existing where it was (prod loses the
  // file) while its destination gets overwritten, so both matter. ln's
  // target/link-name argument creates or changes a filesystem entry, so a
  // prod path there is a mutation too — we keep denying on ANY prod
  // argument here (not just the link-name) as a deliberate conservative
  // choice: `ln -s <prodfile> /tmp/x` (reading via a symlink into prod) is
  // niche enough that leaving it blocked is an acceptable false positive,
  // and untangling ln's argument order (`ln [-s] TARGET LINK_NAME`, or
  // multiple targets with `-t DIR`) isn't worth it for that case. Every
  // other WRITE_COMMANDS entry (rm, rmdir, truncate, chmod, chown, touch,
  // mkdir, sqlite3, tee, sed -i) also lands here: every argument is an
  // operand they mutate (or, for sqlite3/tee, can mutate), so all-argument
  // checking is correct for them too.
  for (const token of rest) {
    if (token.startsWith('-')) continue
    if (isProdPath(token, home)) {
      return deny(`\`${cmd}\` targeting \`${token}\` writes to the prod data dir/checkout.`)
    }
  }
  return null
}

/**
 * Does this segment's invoked command actually run a deploy? Setting
 * SLIPSTREAM_TARGET=prod is only dangerous when it's driving one of these —
 * otherwise it's inert (or, per the regression this guards against, just
 * text that happens to be present, e.g. quoted in a commit message).
 */
function invokesDeploy(cmd, rest) {
  if (DEPLOY_TOOLS.has(cmd) && rest.includes('deploy')) return true
  if (cmd === 'deploy.sh') return true
  if (
    (cmd === 'bash' || cmd === 'sh') &&
    rest.some((t) => !t.startsWith('-') && t.split('/').pop() === 'deploy.sh')
  ) {
    return true
  }
  return false
}

function checkDeploy(cmd, rest, leadingEnv) {
  if (leadingEnv.get('SLIPSTREAM_TARGET') === 'prod' && invokesDeploy(cmd, rest)) {
    return deny('this command sets SLIPSTREAM_TARGET=prod and runs a deploy.')
  }
  if (DEPLOY_TOOLS.has(cmd) && rest.includes('deploy')) {
    const hasTargetProdFlag = rest.some(
      (t, idx) => t === '--target=prod' || (t === '--target' && rest[idx + 1] === 'prod'),
    )
    if (hasTargetProdFlag) {
      return deny(`\`${cmd} deploy --target=prod\` deploys to production.`)
    }
  }
  return null
}

function evaluateSegment(segment, home) {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return null
  const { cmd, rest, leadingEnv } = getInvokedCommand(tokens)
  if (!cmd) return null

  if (cmd === 'systemctl') {
    const hit = checkSystemctl(rest)
    if (hit) return hit
  }

  if (cmd === 'tailscale') {
    const hit = checkTailscale(rest)
    if (hit) return hit
  }

  const writeHit = checkWriteAndRedirect(segment, cmd, rest, home)
  if (writeHit) return writeHit

  const deployHit = checkDeploy(cmd, rest, leadingEnv)
  if (deployHit) return deployHit

  return null
}

/**
 * @param {string} command - the raw bash command string from tool_input.command
 * @param {{ isLinkedWorktree: boolean, home: string }} ctx
 * @returns {null | { reason: string }}
 */
export function evaluateCommand(command, ctx) {
  if (!ctx || !ctx.isLinkedWorktree) return null
  if (typeof command !== 'string' || command.trim() === '') return null

  const segments = splitSegments(stripHeredocs(command))
  for (const rawSegment of segments) {
    const segment = rawSegment.trim()
    if (!segment) continue
    const hit = evaluateSegment(segment, ctx.home)
    if (hit) return hit
  }
  return null
}
