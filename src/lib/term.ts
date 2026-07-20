import type { ITheme } from '@xterm/xterm'
import type { Repo, Session } from './types'
import { CLAUDE_BIN, CLAUDE_FLAGS } from '../../electron/shared/agentCli.js'

export type Line = [text: string, delay: number, tag?: 'ASK' | 'SPIN']

// ANSI color helpers
export const C = {
  dim: (t: string) => `\x1b[90m${t}\x1b[0m`,
  b: (t: string) => `\x1b[1m${t}\x1b[0m`,
  green: (t: string) => `\x1b[38;2;46;207;122m${t}\x1b[0m`,
  blue: (t: string) => `\x1b[38;2;76;141;255m${t}\x1b[0m`,
  amber: (t: string) => `\x1b[38;2;245;165;36m${t}\x1b[0m`,
  violet: (t: string) => `\x1b[38;2;180;147;232m${t}\x1b[0m`,
}

export function terminalTheme(): ITheme {
  const dark = document.documentElement.getAttribute('data-mode') === 'dark'
  return dark
    ? {
        background: '#070c10',
        foreground: '#e9f1f3',
        cursor: '#33dccf',
        cursorAccent: '#070c10',
        selectionBackground: 'rgba(51,220,207,.24)',
        black: '#0d161c',
        red: '#eb4763',
        green: '#2fcf7a',
        yellow: '#f5a524',
        blue: '#4c8dff',
        magenta: '#b493e8',
        cyan: '#33dccf',
        white: '#aebdc4',
        brightBlack: '#6f838d',
        brightRed: '#ff6b81',
        brightGreen: '#5ce39a',
        brightYellow: '#ffbe54',
        brightBlue: '#7aa9ff',
        brightMagenta: '#c9b0f0',
        brightCyan: '#5ee9df',
        brightWhite: '#e9f1f3',
      }
    : {
        background: '#ffffff',
        foreground: '#0b141a',
        cursor: '#0a9d94',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(10,157,148,.16)',
        black: '#0b141a',
        red: '#d32d4b',
        green: '#1a9d5c',
        yellow: '#b9700a',
        blue: '#2f6fe0',
        magenta: '#7c53c9',
        cyan: '#0a9d94',
        white: '#5a6b72',
        brightBlack: '#8697a0',
        brightRed: '#e04a63',
        brightGreen: '#22b06c',
        brightYellow: '#cf8412',
        brightBlue: '#4a83ec',
        brightMagenta: '#9068d6',
        brightCyan: '#12b0a5',
        brightWhite: '#0b141a',
      }
}

export function buildScript(s: Session, r: Repo): Line[] {
  const wt = `.worktrees/${r.org}-${r.name}/${s.branch}`
  const L: Line[] = [
    [C.dim(`$ git worktree add ${wt} -b ${s.branch} ${r.base}`), 30],
    [C.dim(`Preparing worktree (new branch '${s.branch}')`), 200],
    [`${C.green('✓')} worktree ready  ${C.dim('· floo → port 51840')}`, 240],
    ['', 50],
    [C.dim(`$ ${CLAUDE_BIN} ${CLAUDE_FLAGS.skipPermissions}`), 40],
    ['', 40],
    [`${C.violet('✻ ')}${C.b('Claude Code')}${C.dim('  dangerous mode')}`, 180],
    [`${C.dim('> ')}${s.tid}: ${s.title}`, 240],
    ['', 110],
  ]
  if (s.status === 'done') {
    L.push(
      [`${C.blue('● ')}Edited ${C.dim('router.config.ts, routes.tsx +12')}`, 240],
      [`${C.blue('● ')}Ran ${C.dim('pnpm test  ')}${C.green('→ 120 passing')}`, 300],
      ['', 70],
      [`${C.green('✓ ')}${C.b('Done.')} 14 files changed ${C.green('+96')} ${C.dim('−120')}.`, 180],
      [`${C.dim('  Opened PR ')}${C.blue('#284')}${C.dim(' → ready for review.')}`, 140],
    )
  } else if (s.status === 'needs') {
    L.push(
      [`${C.blue('● ')}Read ${C.dim('src/auth/session.ts, refresh.ts')}`, 250],
      [`${C.blue('● ')}Traced ${C.dim('the redirect loop to stale refresh tokens')}`, 300],
      ['', 110],
      [`${C.amber('◆ ')}${C.b('I need a decision before continuing:')}`, 240],
      [C.dim('  On refresh, existing sessions can be invalidated (safer)'), 110],
      [C.dim('  or migrated to the new token (smoother).'), 110],
      ['', 80],
      [C.dim('  [1] invalidate   [2] migrate'), 70, 'ASK'],
    )
  } else {
    L.push(
      [`${C.blue('● ')}Implemented ${C.dim('LRU eviction with a capacity bound')}`, 260],
      [`${C.blue('● ')}Running ${C.dim('test suite…')}`, 200],
      [`${C.green('  ✓')}${C.dim(' cache.test.ts      ')}${C.green('12 passed')}`, 180],
      [`${C.green('  ✓')}${C.dim(' eviction.test.ts   ')}${C.green('9 passed')}`, 180],
      [`${C.dim('  ◌ integration.test.ts ')}${C.dim('running… 84/120')}`, 200, 'SPIN'],
    )
  }
  return L
}
