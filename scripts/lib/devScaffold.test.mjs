import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scaffoldPath = path.join(__dirname, 'devScaffold.sh')

// Extracts the literal body of the `cat > "$serve_script" <<'EOF' ... EOF`
// heredoc from devScaffold.sh — i.e. the real dev-serve.sh wrapper content
// that gets written to disk on every `pnpm deploy`/`pnpm setup`. Testing the
// extracted text (rather than reimplementing it) is what would have caught
// the FLO/TASK-WH96T bug: an apostrophe inside a `${VAR:?word}` diagnostic
// opened an unterminated quote and made the whole wrapper invalid bash.
function extractServeScriptBody(source) {
  const lines = source.split('\n')
  const startIndex = lines.findIndex((line) => /cat > "\$serve_script" <<'EOF'/.test(line))
  if (startIndex === -1) {
    throw new Error('could not find serve_script heredoc start in devScaffold.sh')
  }
  const endIndex = lines.findIndex((line, i) => i > startIndex && line.trim() === 'EOF')
  if (endIndex === -1) {
    throw new Error('could not find terminating EOF for serve_script heredoc')
  }
  return lines.slice(startIndex + 1, endIndex).join('\n') + '\n'
}

describe('devScaffold.sh dev-serve.sh wrapper', () => {
  const source = fs.readFileSync(scaffoldPath, 'utf8')

  it("is generated via a quoted heredoc (<<'EOF'), so $SLIPSTREAM_DEV_ROOT is written literally", () => {
    expect(source).toMatch(/cat > "\$serve_script" <<'EOF'/)
  })

  it('produces syntactically valid bash', () => {
    const body = extractServeScriptBody(source)
    expect(body).toContain('SLIPSTREAM_DEV_ROOT')

    const tmpFile = path.join(os.tmpdir(), `dev-serve-test-${process.pid}-${Date.now()}.sh`)
    fs.writeFileSync(tmpFile, body)
    try {
      // Throws (and vitest fails) if `bash -n` exits non-zero.
      execFileSync('bash', ['-n', tmpFile])
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  })

  it('does not contain an unescaped apostrophe inside a ${VAR:?word} expansion', () => {
    // Regression guard for the exact bug: an apostrophe inside :? triggers
    // bash's quote-removal processing on the word and can open an
    // unterminated quote if unbalanced.
    const offendingPattern = /\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*'[^}]*\}/
    expect(source).not.toMatch(offendingPattern)
  })
})

describe('devScaffold.sh systemd unit template (TASK-WH96T)', () => {
  const source = fs.readFileSync(scaffoldPath, 'utf8')

  it('EnvironmentFile= points at the new ~/.local/share/slipstream-dev/slots/%i.env location, not ~/.config/slipstream', () => {
    expect(source).toMatch(/^EnvironmentFile=%h\/\.local\/share\/slipstream-dev\/slots\/%i\.env$/m)
    expect(source).not.toMatch(/EnvironmentFile=%h\/\.config\/slipstream\/dev-slots\/%i\.env/)
  })

  it('creates the new slots dir with mode 700', () => {
    expect(source).toMatch(/slots_dir="\$\{HOME\}\/\.local\/share\/slipstream-dev\/slots"/)
    expect(source).toMatch(/mkdir -p "\$slots_dir"/)
    expect(source).toMatch(/chmod 700 "\$slots_dir"/)
  })

  it('uses %i (not %I) so the raw slug is not systemd-escaped', () => {
    // %I would systemd-escape the instance name (turning '-' into literal
    // '\x2d'), desyncing it from the plain-slug env filename deploy.sh
    // writes (SLOT_ENV_DIR/<slug>.env) — see devUnitName()'s docstring in
    // scripts/lib/devSlots.mjs.
    expect(source).toMatch(/EnvironmentFile=%h\/\.local\/share\/slipstream-dev\/slots\/%i\.env/)
    expect(source).not.toMatch(/%I/)
  })
})
