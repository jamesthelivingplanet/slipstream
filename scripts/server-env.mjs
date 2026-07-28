#!/usr/bin/env node
// server-env.mjs — CLI over scripts/lib/serverEnv.mjs's pure decision logic.
// scripts/setup.sh shells out to this to decide whether an EXISTING
// ~/.config/slipstream/server.env needs SLIPSTREAM_SANDBOX appended, without
// reimplementing the grep/append logic a second time in bash.
//
// Usage:
//   node scripts/server-env.mjs apply-sandbox <envFile> <bwrap|none>
// Prints 'appended' or 'unchanged' to stdout; writes the file only if it
// appended.

import { applySandboxLine, readEnvLines, writeEnvLines } from './lib/serverEnv.mjs'

const [, , cmd, filePath, mode] = process.argv

if (cmd !== 'apply-sandbox' || !filePath || !mode) {
  console.error('Usage: node scripts/server-env.mjs apply-sandbox <envFile> <bwrap|none>')
  process.exit(1)
}
if (mode !== 'bwrap' && mode !== 'none') {
  console.error(`✗ Unknown sandbox mode: '${mode}' (expected 'bwrap' or 'none')`)
  process.exit(1)
}

const existing = readEnvLines(filePath)
const { lines, changed } = applySandboxLine(existing, mode)
if (changed) {
  writeEnvLines(filePath, lines)
}
console.log(changed ? 'appended' : 'unchanged')
