#!/usr/bin/env node
// readiness.mjs — thin CLI for `pnpm readiness` (FLO-142).
//
// Gathers the real facts a running-or-about-to-run deployment presents
// (server.env, filesystem permissions, whether bwrap is actually on PATH,
// the stamped package.json version) and hands them to the pure decision
// function in scripts/lib/readiness.mjs, which turns them into a gate-by-
// gate verdict. See that file for WHY this exists — several hardening
// features are opt-in, and SLIPSTREAM_SANDBOX=bwrap without bwrap on PATH
// fails open silently (electron/services/agentSandbox.ts), which is exactly
// the kind of gap "the feature shipped" doesn't catch but "is it ACTIVE on
// this deployment" does.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { evaluateReadiness } from './lib/readiness.mjs'
import { prodDataDirDefault } from './lib/devDataDir.mjs'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))

/** Parses a server.env file's contents permissively into a plain object. */
export function parseEnvFile(content) {
  const result = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/**
 * Reads `<configDir>/server.env` (the platform config location scripts/
 * setup.sh and scripts/serve-with-env.sh both write/read on Linux —
 * ~/.config/slipstream/server.env). Missing file ⇒ {}. Merged with
 * process.env so operator-supplied overrides still surface, but the file
 * WINS on conflicts — server.env is what the service actually runs with.
 *
 * Also reports whether server.env was actually found, so gatherFacts can
 * detect the bwrap-sandbox-shadow case (FLO-142 follow-up) without stat-ing
 * the file a second time.
 */
function loadServerEnv(configDir) {
  const envFilePath = path.join(configDir, 'server.env')
  const serverEnvFound = existsSync(envFilePath)
  const fileEnv = serverEnvFound ? parseEnvFile(readFileSync(envFilePath, 'utf8')) : {}
  return { env: { ...process.env, ...fileEnv }, serverEnvFound }
}

/** Scans PATH for an executable file named `bwrap` (fs only, no spawn). */
function isBwrapOnPath(pathEnv) {
  const dirs = (pathEnv || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, 'bwrap')
    if (existsSync(candidate)) {
      try {
        const st = statSync(candidate)
        if (st.isFile()) return true
      } catch {
        // unreadable/racing — keep scanning the rest of PATH
      }
    }
  }
  return false
}

/** statSync's mode bits for `filePath`, or { exists: false } if it can't be read. */
function statPerms(filePath) {
  if (!existsSync(filePath)) return { exists: false, mode: undefined }
  try {
    return { exists: true, mode: statSync(filePath).mode & 0o777 }
  } catch {
    return { exists: false, mode: undefined }
  }
}

function gatherFacts() {
  const configDir = path.join(homedir(), '.config', 'slipstream')
  const { env, serverEnvFound } = loadServerEnv(configDir)

  const dataDir = env.SLIPSTREAM_DATA_DIR
    ? path.resolve(env.SLIPSTREAM_DATA_DIR)
    : prodDataDirDefault({ env, platform: process.platform, homedir: homedir() })

  const dataDirStat = statPerms(dataDir)
  const daemonJsonStat = statPerms(path.join(dataDir, 'daemon.json'))
  const secretKeyExists = existsSync(path.join(dataDir, 'secret.key'))
  const secretSaltExists = existsSync(path.join(dataDir, 'secret.salt'))
  const bwrapOnPath = isBwrapOnPath(env.PATH)

  let version
  try {
    version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  } catch {
    version = undefined
  }

  // sandboxShadowed (FLO-142 follow-up): this process is inside an agent PTY
  // (SLIPSTREAM_SESSION_ID injected by electron/services/agentEnv.ts) AND the
  // data dir it sees exists AND server.env was NOT found there — the
  // signature of a bwrap-sandboxed PTY, whose agentSandbox.ts overmounts the
  // data dir with an empty tmpfs and only re-binds sessions/<sid>, bin and
  // clipboard back in (docs/SECURITY.md §7). A non-sandboxed agent PTY still
  // sees server.env, so it is not flagged.
  const inAgentPty = Boolean(env.SLIPSTREAM_SESSION_ID && env.SLIPSTREAM_SESSION_ID.length > 0)
  const sandboxShadowed = inAgentPty && dataDirStat.exists && !serverEnvFound

  return {
    facts: {
      env,
      bwrapOnPath,
      dataDirExists: dataDirStat.exists,
      dataDirMode: dataDirStat.mode,
      daemonJsonExists: daemonJsonStat.exists,
      daemonJsonMode: daemonJsonStat.mode,
      secretKeyExists,
      secretSaltExists,
      version,
      sandboxShadowed,
    },
    dataDir,
  }
}

const STATUS_GLYPH = { pass: '✔', warn: '△', fail: '✘', info: 'ℹ' }

function printReport(result, dataDir) {
  console.log(`Slipstream production-readiness — posture: ${result.posture}, data dir: ${dataDir}`)
  if (result.shadowed) {
    console.log('')
    console.log(
      "⚠️  INCONCLUSIVE — running inside a bwrap-sandboxed agent PTY; the data dir above is a tmpfs overmount, not the host's. See the observation-scope check below.",
    )
  }
  console.log('')
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const check of result.checks) {
    counts[check.status] += 1
    const glyph = STATUS_GLYPH[check.status]
    console.log(`${glyph} [${check.status.toUpperCase()}] ${check.id} — ${check.title}`)
    console.log(`    ${check.detail}`)
    console.log(`    ${check.doc}`)
  }
  console.log('')
  console.log('See docs/PRODUCTION-READINESS.md for the full hardening checklist.')
  if (result.shadowed) {
    console.log(
      `Summary: INCONCLUSIVE (sandbox-shadowed) — ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.info} info. Re-run on the host for a real verdict.`,
    )
  } else {
    console.log(
      `Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.info} info.`,
    )
  }
}

function main() {
  const { facts, dataDir } = gatherFacts()
  const result = evaluateReadiness(facts)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, dataDir }, null, 2))
  } else {
    printReport(result, dataDir)
  }

  // Exit code triple: 0 clean, 1 at least one fail, 2 inconclusive
  // (sandbox-shadowed) regardless of check statuses — a deploy gate must
  // never mistake "couldn't observe the host" for "observed and clean".
  const exitCode = result.shadowed ? 2 : result.ok ? 0 : 1
  process.exit(exitCode)
}

main()
