import { describe, it, expect } from 'vitest'
import { evaluateCommand } from './prodGuard.mjs'

const home = '/home/testuser'
const linked = { isLinkedWorktree: true, home }
const main = { isLinkedWorktree: false, home }

describe('evaluateCommand', () => {
  it('allows everything from the main worktree', () => {
    expect(evaluateCommand('systemctl --user restart slipstream.service', main)).toBeNull()
    expect(evaluateCommand('rm -rf ~/.config/slipstream/slipstream.db', main)).toBeNull()
    expect(evaluateCommand('pnpm deploy --target=prod', main)).toBeNull()
  })

  describe('systemctl on the prod unit', () => {
    it('denies restart on slipstream.service from a linked worktree', () => {
      const result = evaluateCommand('systemctl --user restart slipstream.service', linked)
      expect(result).not.toBeNull()
      expect(result.reason).toMatch(/systemctl/)
    })

    it('denies sudo stop on the bare unit name', () => {
      const result = evaluateCommand('sudo systemctl --user stop slipstream', linked)
      expect(result).not.toBeNull()
    })

    it('allows restart on the per-worktree dev unit', () => {
      expect(
        evaluateCommand('systemctl --user restart slipstream-dev@TASK-WH96T.service', linked),
      ).toBeNull()
    })

    it('allows read-only verbs on the prod unit', () => {
      expect(evaluateCommand('systemctl --user status slipstream.service', linked)).toBeNull()
      expect(evaluateCommand('systemctl --user daemon-reload', linked)).toBeNull()
    })

    it('allows journalctl (read-only) regardless of unit', () => {
      expect(evaluateCommand('journalctl --user -u slipstream -n 30', linked)).toBeNull()
    })

    it('denies stop when a prod unit is listed alongside a dev unit', () => {
      // A dev unit's presence must not excuse a prod unit also being
      // targeted in the same invocation.
      const result = evaluateCommand(
        'systemctl --user stop slipstream.service slipstream-dev@x.service',
        linked,
      )
      expect(result).not.toBeNull()
      expect(result.reason).toMatch(/systemctl/)
    })

    it('still allows restart on the dev unit alone', () => {
      expect(
        evaluateCommand('systemctl --user restart slipstream-dev@x.service', linked),
      ).toBeNull()
    })
  })

  describe('tailscale serve/funnel on port 443', () => {
    it('denies serve --bg --https=443', () => {
      const result = evaluateCommand(
        'tailscale serve --bg --https=443 http://127.0.0.1:7421',
        linked,
      )
      expect(result).not.toBeNull()
      expect(result.reason).toMatch(/tailscale/)
    })

    it('allows serve on a non-443 port', () => {
      expect(
        evaluateCommand('tailscale serve --bg --https=8443 http://127.0.0.1:7431', linked),
      ).toBeNull()
    })

    it('allows tailscale serve status', () => {
      expect(evaluateCommand('tailscale serve status', linked)).toBeNull()
    })
  })

  describe('prod data dir / checkout writes', () => {
    it('denies rm -rf on the prod db', () => {
      const result = evaluateCommand('rm -rf ~/.config/slipstream/slipstream.db', linked)
      expect(result).not.toBeNull()
    })

    it('denies redirecting into server.env via $HOME', () => {
      const result = evaluateCommand('echo x > $HOME/.config/slipstream/server.env', linked)
      expect(result).not.toBeNull()
    })

    it('allows reading server.env', () => {
      expect(evaluateCommand('cat ~/.config/slipstream/server.env', linked)).toBeNull()
    })

    it('allows a grep that mentions slipstream.service in a doc', () => {
      expect(evaluateCommand('grep -rn slipstream.service scripts/', linked)).toBeNull()
    })

    it('allows writes under the dev-slots carve-out', () => {
      expect(evaluateCommand('echo x > ~/.config/slipstream/dev-slots/foo.env', linked)).toBeNull()
      expect(evaluateCommand('touch ~/.config/slipstream/dev-slots/foo.env', linked)).toBeNull()
    })

    it('denies sed -i on server.env', () => {
      const result = evaluateCommand("sed -i 's/foo/bar/' ~/.config/slipstream/server.env", linked)
      expect(result).not.toBeNull()
    })

    it('allows a read-only sed on server.env', () => {
      expect(evaluateCommand("sed -n '1,5p' ~/.config/slipstream/server.env", linked)).toBeNull()
    })
  })

  describe('positional write-command checking (cp/install/mv/ln/dd)', () => {
    it('allows cp reading a prod file into scratch', () => {
      expect(
        evaluateCommand('cp ~/.config/slipstream/server.env /tmp/scratch/env-copy', linked),
      ).toBeNull()
    })

    it('allows cp backing up the prod db to scratch', () => {
      expect(
        evaluateCommand('cp ~/.config/slipstream/slipstream.db /tmp/backup.db', linked),
      ).toBeNull()
    })

    it('allows cp grabbing a reference copy of a prod checkout file', () => {
      expect(
        evaluateCommand('cp $HOME/.repositories/slipstream/scripts/deploy.sh /tmp/ref.sh', linked),
      ).toBeNull()
    })

    it('allows dd reading a prod file with if= into scratch', () => {
      expect(
        evaluateCommand('dd if=~/.config/slipstream/slipstream.db of=/tmp/backup.db', linked),
      ).toBeNull()
    })

    it('denies cp writing into a prod destination', () => {
      const result = evaluateCommand('cp /tmp/evil.env ~/.config/slipstream/server.env', linked)
      expect(result).not.toBeNull()
    })

    it('denies cp -t targeting a prod directory', () => {
      const result = evaluateCommand('cp -t ~/.config/slipstream /tmp/evil.env', linked)
      expect(result).not.toBeNull()
    })

    it('denies mv whose source is a prod file (prod loses the file)', () => {
      const result = evaluateCommand('mv ~/.config/slipstream/slipstream.db /tmp/stolen.db', linked)
      expect(result).not.toBeNull()
    })

    it('denies mv whose destination is a prod file (prod gets overwritten)', () => {
      const result = evaluateCommand('mv /tmp/x ~/.config/slipstream/slipstream.db', linked)
      expect(result).not.toBeNull()
    })

    it('denies dd writing to a prod of= destination', () => {
      const result = evaluateCommand(
        'dd if=/tmp/evil of=~/.config/slipstream/slipstream.db',
        linked,
      )
      expect(result).not.toBeNull()
    })

    it('still denies rm -rf on the prod db', () => {
      const result = evaluateCommand('rm -rf ~/.config/slipstream/slipstream.db', linked)
      expect(result).not.toBeNull()
    })

    it('denies install writing into a prod destination', () => {
      const result = evaluateCommand('install /tmp/x ~/.config/slipstream/server.env', linked)
      expect(result).not.toBeNull()
    })

    it('still denies plain shell redirection into a prod file', () => {
      const result = evaluateCommand('echo x > ~/.config/slipstream/server.env', linked)
      expect(result).not.toBeNull()
    })

    it('allows cp into the dev-slots carve-out destination', () => {
      expect(evaluateCommand('cp /tmp/x ~/.config/slipstream/dev-slots/foo.env', linked)).toBeNull()
    })
  })

  describe('pnpm deploy --target=prod', () => {
    it('denies an explicit --target=prod flag', () => {
      expect(evaluateCommand('pnpm deploy --target=prod', linked)).not.toBeNull()
    })

    it('denies SLIPSTREAM_TARGET=prod env prefix', () => {
      expect(evaluateCommand('SLIPSTREAM_TARGET=prod pnpm deploy', linked)).not.toBeNull()
    })

    it('allows a plain pnpm deploy (dev target)', () => {
      expect(evaluateCommand('pnpm deploy', linked)).toBeNull()
    })
  })

  describe('compound commands', () => {
    it('denies when only the second segment is a prod hit', () => {
      const result = evaluateCommand(
        'pnpm build && systemctl --user restart slipstream.service',
        linked,
      )
      expect(result).not.toBeNull()
    })
  })

  describe('heredoc bodies are stripped before evaluation', () => {
    it('REGRESSION: allows a git commit whose heredoc body merely mentions SLIPSTREAM_TARGET=prod', () => {
      // This is the exact reported bug: a commit message describing the
      // guard itself (piped via -F -) was denied because the heredoc body
      // was split into segments and a body line parsed as a leading env
      // assignment plus a body line looked like a systemctl/rm -rf command.
      const cmd = [
        "git commit -F - <<'EOF'",
        'TASK: notes',
        '  SLIPSTREAM_TARGET=prod exit 1 from a worktree, before any build or restart.',
        '  systemctl --user restart slipstream.service',
        '  rm -rf ~/.config/slipstream',
        'EOF',
      ].join('\n')
      expect(evaluateCommand(cmd, linked)).toBeNull()
    })

    it('still denies tee into the prod data dir even though it opens a heredoc', () => {
      const cmd = ['tee ~/.config/slipstream/server.env <<EOF', 'FOO=bar', 'EOF'].join('\n')
      const result = evaluateCommand(cmd, linked)
      expect(result).not.toBeNull()
    })

    it('still denies cat with redirection on the heredoc-opening line', () => {
      const cmd = ["cat <<'EOF' > ~/.config/slipstream/server.env", 'FOO=bar', 'EOF'].join('\n')
      const result = evaluateCommand(cmd, linked)
      expect(result).not.toBeNull()
    })

    it('strips multiple heredocs in one command; neither body is evaluated', () => {
      const cmd = [
        'diff <<A <<B',
        'first body line mentions SLIPSTREAM_TARGET=prod',
        'A',
        'second body line says rm -rf ~/.config/slipstream',
        'B',
      ].join('\n')
      expect(evaluateCommand(cmd, linked)).toBeNull()
    })

    it('strips a <<-INNER body up to a tab/space-indented terminator', () => {
      const cmd = ['cat <<-INNER', '\tsystemctl --user restart slipstream.service', '\tINNER'].join(
        '\n',
      )
      expect(evaluateCommand(cmd, linked)).toBeNull()
    })

    it('drops everything after an unterminated heredoc without crashing', () => {
      const cmd = ['cat <<EOF', 'rm -rf ~/.config/slipstream', 'no terminator here'].join('\n')
      expect(() => evaluateCommand(cmd, linked)).not.toThrow()
      expect(evaluateCommand(cmd, linked)).toBeNull()
    })
  })

  describe('SLIPSTREAM_TARGET=prod only denies when it actually drives a deploy', () => {
    it('denies SLIPSTREAM_TARGET=prod pnpm deploy', () => {
      expect(evaluateCommand('SLIPSTREAM_TARGET=prod pnpm deploy', linked)).not.toBeNull()
    })

    it('denies SLIPSTREAM_TARGET=prod bash scripts/deploy.sh', () => {
      expect(
        evaluateCommand('SLIPSTREAM_TARGET=prod bash scripts/deploy.sh', linked),
      ).not.toBeNull()
    })

    it('denies SLIPSTREAM_TARGET=prod npm run deploy', () => {
      expect(evaluateCommand('SLIPSTREAM_TARGET=prod npm run deploy', linked)).not.toBeNull()
    })

    it('allows SLIPSTREAM_TARGET=prod echo hi (no deploy invoked)', () => {
      expect(evaluateCommand('SLIPSTREAM_TARGET=prod echo hi', linked)).toBeNull()
    })

    it('still denies pnpm deploy --target=prod regardless of env var', () => {
      expect(evaluateCommand('pnpm deploy --target=prod', linked)).not.toBeNull()
    })
  })
})
