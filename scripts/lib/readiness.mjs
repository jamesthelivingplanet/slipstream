// readiness.mjs — pure decision logic for `pnpm readiness` (FLO-142).
//
// Several production-readiness hardening gates shipped for this repo are
// OPT-IN (SLIPSTREAM_WS_TICKETS, SLIPSTREAM_SECRET, SLIPSTREAM_SANDBOX,
// SLIPSTREAM_ALLOWED_ORIGINS), and one of them fails open silently:
// electron/services/agentSandbox.ts logs a one-time warning and runs the
// agent UNSANDBOXED when SLIPSTREAM_SANDBOX=bwrap is set but `bwrap` is not
// on PATH (see decideSandbox() there). Grepping the codebase for "is the
// feature shipped" doesn't answer "is it ACTIVE on THIS deployment" — this
// module is the single place that turns a snapshot of real facts (parsed
// server.env, filesystem stats, PATH) into a gate-by-gate verdict. Every
// input is passed in as an argument — no env, no fs, no child_process — so
// the decision itself is unit-testable; see readiness.test.mjs. The thin
// I/O edge that gathers those facts and prints the report lives in
// scripts/readiness.mjs.

/**
 * @typedef {'pass'|'warn'|'fail'|'info'} CheckStatus
 * @typedef {{id: string, title: string, status: CheckStatus, detail: string, doc: string}} Check
 */

// Checks whose input is either the (possibly shadowed) data dir or
// server.env — these get downgraded to 'info' when sandboxShadowed is true,
// per the sandbox-shadow rule below. Deliberately includes 'agent-sandbox'
// even though SLIPSTREAM_SANDBOX leaks into the PTY env unshadowed: that
// value describes the daemon that spawned this PTY, not something this
// process read from a server.env/data dir it can trust — a uniform rule
// beats a per-check exception here.
const SHADOWED_CHECK_IDS = new Set([
  'auth-token',
  'ws-tickets',
  'secrets-at-rest',
  'agent-sandbox',
  'origin-allowlist',
  'data-dir-perms',
  'daemon-json-perms',
])

/**
 * evaluateReadiness — PURE. Takes a snapshot of deployment facts and
 * returns an ordered, gate-by-gate verdict.
 *
 * @param {object} facts
 * @param {Record<string,string>} facts.env - parsed server.env merged over
 *   any process.env-supplied values (file wins — see scripts/readiness.mjs).
 * @param {boolean} facts.bwrapOnPath
 * @param {boolean} facts.dataDirExists
 * @param {number|undefined} facts.dataDirMode - permission bits only, e.g. 0o700.
 * @param {boolean} facts.daemonJsonExists
 * @param {number|undefined} facts.daemonJsonMode
 * @param {boolean} facts.secretKeyExists
 * @param {boolean} facts.secretSaltExists
 * @param {string|undefined} facts.version - package.json version.
 * @param {boolean} facts.sandboxShadowed - true when this process is running
 *   inside a bwrap-sandboxed agent PTY, so the data dir / server.env it can
 *   see is a private tmpfs overmount, not the host's real state (see
 *   scripts/readiness.mjs's gatherFacts and docs/SECURITY.md §7). When true,
 *   every check whose input came from that shadowed view is downgraded to
 *   'info' and can never be 'fail' — see SHADOWED_CHECK_IDS above.
 * @returns {{posture: 'tailscale'|'local'|'unknown', checks: Check[], ok: boolean, shadowed: boolean}}
 */
export function evaluateReadiness(facts) {
  const {
    env,
    bwrapOnPath,
    dataDirExists,
    dataDirMode,
    daemonJsonExists,
    daemonJsonMode,
    secretKeyExists,
    secretSaltExists,
    version,
    sandboxShadowed,
  } = facts

  const posture = derivePosture(env.SLIPSTREAM_SERVE)

  let checks = [
    checkAuthToken(env),
    checkWsTickets(env, posture),
    checkSecretsAtRest(env, secretKeyExists, secretSaltExists),
    checkAgentSandbox(env, bwrapOnPath),
    checkOriginAllowlist(env),
    checkDataDirPerms(dataDirExists, dataDirMode),
    checkDaemonJsonPerms(daemonJsonExists, daemonJsonMode),
    checkVersionStamp(version),
    checkMultiUser(),
  ]

  if (sandboxShadowed) {
    checks = [checkObservationScope(), ...checks.map(shadowCheck)]
  }

  const ok = !checks.some((c) => c.status === 'fail')

  return { posture, checks, ok, shadowed: Boolean(sandboxShadowed) }
}

/** Rewrites a normally-computed check to 'info' if it's on the shadowed
 *  list, leaving version-stamp/multi-user (and any future non-shadowed
 *  check) untouched. Never produces 'fail'. */
function shadowCheck(check) {
  if (!SHADOWED_CHECK_IDS.has(check.id)) return check
  return {
    ...check,
    status: 'info',
    detail: `Not observable from inside the sandbox — needs ${shadowedInputLabel(check.id)}, which the sandbox tmpfs hides. Re-run on the host for a real verdict.`,
  }
}

/** Which shadowed input a given check needed, for the uniform info detail. */
function shadowedInputLabel(id) {
  switch (id) {
    case 'data-dir-perms':
      return 'the real data dir'
    case 'daemon-json-perms':
      return 'daemon.json'
    default:
      return 'server.env'
  }
}

/** The always-first check when sandboxShadowed — explains why the rest of
 *  the report can't be trusted, instead of silently downgrading checks with
 *  no explanation at the top. */
function checkObservationScope() {
  return {
    id: 'observation-scope',
    title: 'Observation scope (sandboxed agent PTY)',
    status: 'warn',
    detail:
      "This process is running inside a bwrap-sandboxed agent PTY: the data dir it can see is a private tmpfs overmount, not the host's — server.env, daemon.json, secret.key and the real directory mode are all invisible here, so the host's real posture cannot be observed from this process. Re-run `pnpm readiness` on the host (or from an unsandboxed shell) for a real verdict.",
    doc: 'docs/SECURITY.md §7',
  }
}

/** derivePosture — SLIPSTREAM_SERVE (unset/'none' ⇒ local) → the deployment posture. */
function derivePosture(serveValue) {
  if (serveValue === 'tailscale') return 'tailscale'
  if (serveValue === undefined || serveValue === '' || serveValue === 'none') return 'local'
  return 'unknown'
}

function checkAuthToken(env) {
  const hasToken = Boolean(env.SLIPSTREAM_TOKEN && env.SLIPSTREAM_TOKEN.length > 0)
  return {
    id: 'auth-token',
    title: 'SLIPSTREAM_TOKEN is set',
    status: hasToken ? 'pass' : 'fail',
    detail: hasToken
      ? 'SLIPSTREAM_TOKEN is present — the headless server has an auth token to check.'
      : 'SLIPSTREAM_TOKEN is missing or empty — the headless server refuses to start without it. Set it in server.env.',
    doc: 'docs/SECURITY.md §1',
  }
}

function checkWsTickets(env, posture) {
  const id = 'ws-tickets'
  const title = 'One-time WS ticket flow (SLIPSTREAM_WS_TICKETS)'
  const doc = 'docs/SECURITY.md §3'

  if (posture === 'tailscale') {
    return {
      id,
      title,
      status: 'info',
      detail:
        'Posture is tailscale — the ticket flow is not needed (an encrypted tunnel has no intermediary that logs the URL); harmless if SLIPSTREAM_WS_TICKETS is set anyway.',
      doc,
    }
  }

  const enabled = env.SLIPSTREAM_WS_TICKETS === '1'
  return {
    id,
    title,
    status: enabled ? 'pass' : 'warn',
    detail: enabled
      ? 'SLIPSTREAM_WS_TICKETS=1 — the browser client exchanges a short-lived ticket instead of putting the bearer token in the WS URL.'
      : "SLIPSTREAM_WS_TICKETS is not set to '1' — the browser client will put the long-lived token in the WS URL, where a reverse proxy's access log records it on every reconnect. This only matters if a reverse proxy actually fronts the daemon.",
    doc,
  }
}

// secretSaltExists (secret.salt, paired with SLIPSTREAM_SECRET) is accepted
// as a fact for completeness but does not change the verdict on its own —
// only SLIPSTREAM_SECRET / secret.key presence does — so it is intentionally
// unused here.
function checkSecretsAtRest(env, secretKeyExists, _secretSaltExists) {
  const id = 'secrets-at-rest'
  const title = 'Server-side secret encryptor for config-table secrets'
  const doc = 'docs/SECURITY.md §6'

  if (env.SLIPSTREAM_SECRET && env.SLIPSTREAM_SECRET.length > 0) {
    return {
      id,
      title,
      status: 'pass',
      detail:
        'SLIPSTREAM_SECRET is set — the encryption key is derived via scrypt from the operator passphrase and never touches disk.',
      doc,
    }
  }

  if (secretKeyExists) {
    return {
      id,
      title,
      status: 'pass',
      detail:
        'No SLIPSTREAM_SECRET, but a file-backed secret.key exists — it sits in the data dir, so it does not survive theft of the whole data dir the way SLIPSTREAM_SECRET does.',
      doc,
    }
  }

  return {
    id,
    title,
    status: 'warn',
    detail:
      'No SLIPSTREAM_SECRET and no secret.key yet — no server encryptor has materialized (the daemon creates secret.key on first start), so config secrets may still be plaintext in the DB.',
    doc,
  }
}

function checkAgentSandbox(env, bwrapOnPath) {
  const id = 'agent-sandbox'
  const title = 'bwrap agent sandbox (SLIPSTREAM_SANDBOX)'
  const doc = 'docs/SECURITY.md §7'
  const requested = env.SLIPSTREAM_SANDBOX === 'bwrap'

  if (requested && bwrapOnPath) {
    return {
      id,
      title,
      status: 'pass',
      detail: 'SLIPSTREAM_SANDBOX=bwrap and bwrap is on PATH — agent PTYs run inside the sandbox.',
      doc,
    }
  }

  if (requested && !bwrapOnPath) {
    return {
      id,
      title,
      status: 'fail',
      detail:
        'SLIPSTREAM_SANDBOX=bwrap is set but bwrap is NOT on PATH — the sandbox FAILS OPEN and agents run UNSANDBOXED. Setting the env var alone guarantees nothing; install bwrap or unset the var to be honest about the posture.',
      doc,
    }
  }

  return {
    id,
    title,
    status: 'warn',
    detail:
      "Sandbox is not requested (SLIPSTREAM_SANDBOX unset/none) — agents run as the daemon's uid with full read of the data dir (daemon.json, slipstream.db). Note bwrap containment is filesystem-only even when on.",
    doc,
  }
}

function checkOriginAllowlist(env) {
  const enabled = Boolean(
    env.SLIPSTREAM_ALLOWED_ORIGINS && env.SLIPSTREAM_ALLOWED_ORIGINS.length > 0,
  )
  return {
    id: 'origin-allowlist',
    title: 'Origin allowlist for browser clients (SLIPSTREAM_ALLOWED_ORIGINS)',
    status: enabled ? 'pass' : 'warn',
    detail: enabled
      ? 'SLIPSTREAM_ALLOWED_ORIGINS is set — disallowed cross-origin browser connections are rejected pre-handshake.'
      : 'SLIPSTREAM_ALLOWED_ORIGINS is unset — defense-in-depth only, since token-gating already blocks cross-site/DNS-rebind connections.',
    doc: 'docs/SECURITY.md §9',
  }
}

function checkDataDirPerms(dataDirExists, dataDirMode) {
  const id = 'data-dir-perms'
  const title = 'Data dir permissions'
  const doc = 'docs/SECURITY.md §7'

  if (!dataDirExists) {
    return {
      id,
      title,
      status: 'info',
      detail: 'Data dir does not exist yet — nothing deployed here.',
      doc,
    }
  }

  if (dataDirMode === 0o700) {
    return { id, title, status: 'pass', detail: 'Data dir is 0700 — owner-only access.', doc }
  }

  return {
    id,
    title,
    status: 'fail',
    detail: `Data dir mode is ${modeString(dataDirMode)}, not 0700 — it is group/world-accessible.`,
    doc,
  }
}

function checkDaemonJsonPerms(daemonJsonExists, daemonJsonMode) {
  const id = 'daemon-json-perms'
  const title = 'daemon.json permissions'
  const doc = 'docs/SECURITY.md §7'

  if (!daemonJsonExists) {
    return {
      id,
      title,
      status: 'info',
      detail: 'daemon.json does not exist — no detached daemon has run here.',
      doc,
    }
  }

  if (daemonJsonMode === 0o600) {
    return { id, title, status: 'pass', detail: 'daemon.json is 0600 — owner-only access.', doc }
  }

  return {
    id,
    title,
    status: 'fail',
    detail: `daemon.json mode is ${modeString(daemonJsonMode)}, not 0600 — a file holding a bearer token is group/world-readable.`,
    doc,
  }
}

function checkVersionStamp(version) {
  const valid = Boolean(version && version !== '0.0.0')
  return {
    id: 'version-stamp',
    title: 'Version stamp',
    status: valid ? 'pass' : 'fail',
    detail: valid
      ? `package.json version is ${version}.`
      : `package.json version is ${version ?? 'missing'} — no meaningful release version is stamped.`,
    doc: 'docs/VERSIONING.md',
  }
}

function checkMultiUser() {
  return {
    id: 'multi-user',
    title: 'Multi-user / per-device identity',
    status: 'info',
    detail:
      "The static SLIPSTREAM_TOKEN resolves to the single 'local' owner; per-device/per-user credentials are issued out of band with `pnpm tokens -- list|issue|revoke`, which this check cannot inspect (it does not open the DB).",
    doc: 'docs/IDENTITY-SEAM.md',
  }
}

function modeString(mode) {
  return mode === undefined ? 'unknown' : `0${mode.toString(8)}`
}
