/**
 * Realistic claude-code-style TUI output snippets used to exercise
 * StatusDetector against real-world formatting (ANSI escapes, box-draw
 * characters, spinners) rather than synthetic one-liners.
 */

import { NEEDS_INPUT_MARKER, DONE_MARKER } from '../../shared/promptComposer.js'

// A claude-code tool-permission box ending in a numbered select menu with a
// trailing arrow pointing at the highlighted option.
export const permissionPrompt =
  '\x1B[1mBash command\x1B[0m\n' +
  '\x1B[2m╭─────────────────────────────────────────╮\x1B[0m\n' +
  '\x1B[2m│\x1B[0m rm -rf ./dist                            \x1B[2m│\x1B[0m\n' +
  '\x1B[2m╰─────────────────────────────────────────╯\x1B[0m\n' +
  'Do you want to proceed?\n' +
  '\x1B[36m❯ 1. Yes\x1B[0m\n' +
  '  2. Yes, and don’t ask again\n' +
  '  3. No, and tell Claude what to do differently\n'

// A "thinking" spinner line — must NOT be classified as a question.
export const thinkingSpinner =
  '\x1B[2K\x1B[1G\x1B[35m✿\x1B[0m Thinking… \x1B[2m(esc to interrupt)\x1B[0m'

// Multi-line file-edit / bash tool output stream, no question anywhere.
export const toolOutputStream =
  '\x1B[1mEdit(src/app.ts)\x1B[0m\n' +
  '  \x1B[32m+ export function foo() {\x1B[0m\n' +
  '  \x1B[32m+   return 42\x1B[0m\n' +
  '  \x1B[32m+ }\x1B[0m\n' +
  '\x1B[1mBash(pnpm test)\x1B[0m\n' +
  'Running 42 tests...\n' +
  'All tests passed\n'

// A free-text question with no special markup, ending in a question mark.
export const plainQuestion =
  'I found two possible approaches to fix this bug.\n' +
  'Should I use approach A (patch the regex) or approach B (rewrite the parser)?'

// Final summary followed by the DONE marker at the very tail.
export const doneWithMarker =
  'Ran the full test suite — all 128 tests pass.\n' +
  'Opened merge request: https://gitlab.example.com/org/repo/-/merge_requests/42\n' +
  `${DONE_MARKER}`

// Body text followed by the NEEDS_INPUT marker at the tail.
export const needsWithMarker =
  'I need to know which database migration strategy you prefer before continuing.\n' +
  `${NEEDS_INPUT_MARKER}`
