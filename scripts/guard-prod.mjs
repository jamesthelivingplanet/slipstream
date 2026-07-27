#!/usr/bin/env node
/**
 * PreToolUse hook wrapper for Bash: reads the hook payload from stdin,
 * decides whether cwd is a linked git worktree, and asks
 * scripts/lib/prodGuard.mjs whether the command touches production.
 *
 * All logic lives in prodGuard.mjs (pure + unit tested); this file is only
 * I/O plumbing. Any internal failure here (bad JSON, git not available,
 * missing fields) must fall through to allowing the command — this guard
 * must never wedge the agent's shell.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { evaluateCommand } from './lib/prodGuard.mjs'

function readStdin() {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

function isLinkedWorktree(cwd) {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd,
    encoding: 'utf-8',
  }).trim()
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
  }).trim()
  const absCommonDir = commonDir.startsWith('/') ? commonDir : `${cwd}/${commonDir}`
  return gitDir.includes(`${absCommonDir.replace(/\/$/, '')}/worktrees/`)
}

function main() {
  const raw = readStdin()
  const payload = JSON.parse(raw)
  const command = payload.tool_input.command
  const cwd = payload.cwd || process.cwd()

  const linked = isLinkedWorktree(cwd)
  const result = evaluateCommand(command, { isLinkedWorktree: linked, home: homedir() })

  if (result) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
        },
      }),
    )
  }
  process.exit(0)
}

try {
  main()
} catch {
  // Never wedge the agent's shell on an internal guard failure.
  process.exit(0)
}
