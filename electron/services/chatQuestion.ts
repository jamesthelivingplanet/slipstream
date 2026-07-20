/**
 * chatQuestion — pure excerpt logic for the ChatView needs-input card
 * (TASK-FPH60): when the agent hasn't reported an activity message (an
 * interactive permission prompt freezes the agent process before it can
 * write to the status.json sentinel), fall back to a readable excerpt of
 * the live headless-screen mirror (screenState.ts's ScreenState.snapshot()).
 *
 * Pure / side-effect-free and directly unit-testable: feed the raw
 * (ANSI-laden) screen serialization, get back a plain-text excerpt or null.
 */

import { stripAnsi } from './statusDetector.js'

/** Cap on how many non-empty lines the excerpt keeps, counted from the tail. */
const MAX_LINES = 15

// A line made up entirely of box-drawing borders, spinner glyphs, bullets,
// and whitespace carries no question text — treated the same as a blank
// line for trimming/counting purposes.
const NOISE_LINE_RE = /^[\s│║╎┆┊╽╿─━═╌╍╭╮╰╯┌┐└┘├┤┬┴┼▏▕▔▁⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●○◦·.…]*$/

function isNoiseLine(line: string): boolean {
  return NOISE_LINE_RE.test(line)
}

/**
 * Extract a readable tail excerpt from a live terminal screen serialization.
 *
 * Strips ANSI/VT escapes, drops trailing blank lines and box-drawing/spinner
 * noise, then keeps at most `MAX_LINES` non-empty lines counting back from
 * the end — interior blank/noise lines within that window are preserved so
 * the excerpt keeps its relative layout (e.g. a boxed permission prompt).
 * Returns null when nothing meaningful remains (blank screen, pure chrome).
 */
export function extractScreenQuestion(rawScreenText: string): string | null {
  const plain = stripAnsi(rawScreenText)
  let lines = plain.split(/\r\n|\r|\n/)

  // Drop trailing blank/noise lines.
  let end = lines.length
  while (end > 0 && (lines[end - 1].trim() === '' || isNoiseLine(lines[end - 1]))) {
    end--
  }
  lines = lines.slice(0, end)
  if (lines.length === 0) return null

  // Walk backward, counting non-empty/non-noise lines toward the cap. Stop
  // once the cap is hit (exclusive of the line that tipped it over), keeping
  // everything from there to the end — including interior blanks — intact.
  let nonEmptyCount = 0
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const meaningful = line.trim() !== '' && !isNoiseLine(line)
    if (meaningful) {
      nonEmptyCount++
      if (nonEmptyCount > MAX_LINES) {
        start = i + 1
        break
      }
    }
    start = i
  }

  const excerpt = lines.slice(start).join('\n').trim()
  return excerpt === '' ? null : excerpt
}
