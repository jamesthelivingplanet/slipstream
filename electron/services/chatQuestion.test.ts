import { describe, it, expect } from 'vitest'
import { extractScreenQuestion } from './chatQuestion.js'

// A realistic Claude Code interactive permission-prompt screen: colored box,
// a spinner line below it, then a stretch of blank lines padding out the
// rest of the terminal's rows (typical of a headless-screen serialization at
// a fixed geometry). ANSI SGR codes are interleaved the way xterm's
// SerializeAddon actually emits them.
const PERMISSION_PROMPT_SCREEN = [
  '\x1b[38;5;250mSome earlier output that scrolled off\x1b[0m',
  'Reading src/lib/foo.ts…',
  '',
  '\x1b[1m╭─────────────────────────────────────────╮\x1b[0m',
  '\x1b[1m│\x1b[0m Bash command                             \x1b[1m│\x1b[0m',
  '\x1b[1m│\x1b[0m                                           \x1b[1m│\x1b[0m',
  '\x1b[1m│\x1b[0m   rm -rf node_modules                    \x1b[1m│\x1b[0m',
  '\x1b[1m│\x1b[0m                                           \x1b[1m│\x1b[0m',
  '\x1b[1m│\x1b[0m Do you want to proceed?                  \x1b[1m│\x1b[0m',
  '\x1b[1m│\x1b[0m \x1b[35m❯ 1. Yes\x1b[0m                                 \x1b[1m│\x1b[0m',
  "\x1b[1m│\x1b[0m   2. Yes, and don't ask again             \x1b[1m│\x1b[0m",
  '\x1b[1m│\x1b[0m   3. No, and tell Claude what to do      \x1b[1m│\x1b[0m',
  '\x1b[1m╰─────────────────────────────────────────╯\x1b[0m',
  '\x1b[2m⠋\x1b[0m',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
].join('\r\n')

describe('extractScreenQuestion', () => {
  it('strips ANSI, drops trailing blanks/spinner/border noise, keeps the prompt text', () => {
    const excerpt = extractScreenQuestion(PERMISSION_PROMPT_SCREEN)
    expect(excerpt).not.toBeNull()
    expect(excerpt).toContain('Bash command')
    expect(excerpt).toContain('rm -rf node_modules')
    expect(excerpt).toContain('Do you want to proceed?')
    expect(excerpt).toContain('1. Yes')
    // The trailing blank padding, spinner glyph, and the closing box border
    // (pure box-drawing chars, no text) are all noise and get dropped — the
    // last surviving line is the final menu option's text.
    expect(excerpt).toContain('3. No, and tell Claude what to do')
    expect(excerpt?.trimEnd().endsWith('│')).toBe(true)
    expect(excerpt).not.toContain('╰')
    expect(excerpt).not.toContain('⠋')
    // No raw escape bytes survive.
    // eslint-disable-next-line no-control-regex -- asserting the ESC byte is gone
    expect(/\x1B/.test(excerpt ?? '')).toBe(false)
  })

  it('caps the excerpt at ~15 non-empty lines, keeping the tail', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const screen = lines.join('\n')
    const excerpt = extractScreenQuestion(screen)
    expect(excerpt).not.toBeNull()
    const kept = (excerpt as string).split('\n')
    expect(kept.length).toBeLessThanOrEqual(15)
    expect(kept[kept.length - 1]).toBe('line 39')
    expect(kept[0]).toBe('line 25')
  })

  it('preserves interior blank lines for layout within the kept window', () => {
    const screen = ['question line 1', '', 'question line 2', ''].join('\n')
    const excerpt = extractScreenQuestion(screen)
    expect(excerpt).toBe('question line 1\n\nquestion line 2')
  })

  it('returns null for a blank screen', () => {
    expect(extractScreenQuestion('\n\n   \n\n')).toBeNull()
  })

  it('returns null when the screen is pure box-drawing/spinner chrome', () => {
    expect(extractScreenQuestion('╭───╮\n│   │\n╰───╯\n⠋\n')).toBeNull()
  })

  it('leaves plain text with no noise unchanged (minus trailing whitespace)', () => {
    expect(extractScreenQuestion('hello\nworld')).toBe('hello\nworld')
  })
})
