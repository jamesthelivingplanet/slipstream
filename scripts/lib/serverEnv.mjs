// serverEnv.mjs — pure decision logic for how scripts/setup.sh mutates an
// EXISTING ~/.config/slipstream/server.env when managing SLIPSTREAM_SANDBOX.
//
// SLIPSTREAM_SANDBOX is STICKY once present: an operator's explicit past
// choice (including SLIPSTREAM_SANDBOX=none) is never overwritten, unlike
// SLIPSTREAM_SERVE, which setup.sh updates on every re-run. See
// scripts/lib/serverEnv.test.mjs and scripts/setup.sh.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SANDBOX_LINE_RE = /^SLIPSTREAM_SANDBOX=/

/**
 * applySandboxLine — PURE. `lines` is the existing server.env split into
 * lines (no trailing newline entries). `mode` is 'bwrap' or 'none' — the
 * value to append when the key is absent. Returns { lines, changed }:
 * `lines` is a NEW array (input is never mutated), `changed` is true iff a
 * line was appended. If a SLIPSTREAM_SANDBOX= line already exists, `lines`
 * is returned as an unchanged copy regardless of `mode` — the whole point is
 * that an existing choice always wins.
 */
export function applySandboxLine(lines, mode) {
  if (lines.some((line) => SANDBOX_LINE_RE.test(line))) {
    return { lines: [...lines], changed: false }
  }
  return { lines: [...lines, `SLIPSTREAM_SANDBOX=${mode}`], changed: true }
}

// --- thin fs edges, not unit tested directly (exercised via the CLI) ---

/** readEnvLines — loads `filePath` split into lines, or [] if absent/empty. */
export function readEnvLines(filePath) {
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf8')
  if (content === '') return []
  return content.replace(/\n$/, '').split('\n')
}

/** writeEnvLines — persists `lines` to `filePath`, one per line, trailing newline. */
export function writeEnvLines(filePath, lines) {
  writeFileSync(filePath, lines.join('\n') + '\n')
}
