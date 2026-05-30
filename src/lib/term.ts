import type { ITheme } from '@xterm/xterm'
import type { Repo, Session } from './types'

export type Line = [text: string, delay: number, tag?: 'ASK' | 'SPIN']

// ANSI color helpers
export const C = {
  dim: (t: string) => `\x1b[90m${t}\x1b[0m`,
  b: (t: string) => `\x1b[1m${t}\x1b[0m`,
  green: (t: string) => `\x1b[38;2;74;222;128m${t}\x1b[0m`,
  blue: (t: string) => `\x1b[38;2;96;165;250m${t}\x1b[0m`,
  amber: (t: string) => `\x1b[38;2;251;191;36m${t}\x1b[0m`,
  violet: (t: string) => `\x1b[38;2;167;139;250m${t}\x1b[0m`,
}

export function terminalTheme(): ITheme {
  const dark = document.documentElement.getAttribute('data-mode') === 'dark'
  return dark
    ? {
        background: '#0a0a0c', foreground: '#e4e4e7', cursor: '#a78bfa',
        selectionBackground: 'rgba(167,139,250,.25)',
        black: '#18181b', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7',
        brightBlack: '#52525b', brightWhite: '#fafafa',
      }
    : {
        background: '#fafafa', foreground: '#27272a', cursor: '#7c3aed',
        selectionBackground: 'rgba(124,58,237,.18)',
        black: '#27272a', red: '#dc2626', green: '#16a34a', yellow: '#d97706',
        blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#52525b',
        brightBlack: '#a1a1aa', brightWhite: '#000000',
      }
}

export function buildScript(s: Session, r: Repo): Line[] {
  const wt = `.worktrees/${r.org}-${r.name}/${s.branch}`
  const L: Line[] = [
    [C.dim(`$ git worktree add ${wt} -b ${s.branch} ${r.base}`), 30],
    [C.dim(`Preparing worktree (new branch '${s.branch}')`), 200],
    [`${C.green('✓')} worktree ready  ${C.dim('· floo → port 51840')}`, 240],
    ['', 50],
    [C.dim('$ claude --dangerously-skip-permissions'), 40],
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
