// Copy for first-boot onboarding (TASK-EQOP4): the pixel-angel mascot's name
// reveal plus a guided tour of the app. Same discipline as fabTipsContent.ts —
// every claim names a real, reachable feature, verified against the
// implementing component and cited in a comment beside it. No invented
// features, keybindings, or gestures.

// MASCOT_NAME now lives in electron/shared/mascot.ts (TASK-F0TYG) — that
// module is importable from both the renderer and the daemon (push
// notification copy needs it too), whereas this file is renderer-only.
// Re-exported here under the original name so every existing import
// (pager nameplate, modal header, etc.) keeps working unchanged.
import { MASCOT_NAME } from '../../electron/shared/mascot.js'
export { MASCOT_NAME }

/** Hard cap enforced by onboardingContent.test.ts — keeps a speech-bubble
 *  line readable on a phone width without wrapping into a wall of text. */
export const ONBOARDING_LINE_MAX_LENGTH = 140
/** Hard cap for the optional supporting body paragraph under a line. */
export const ONBOARDING_BODY_MAX_LENGTH = 180
/** Hard cap for a single bullet item. */
export const ONBOARDING_BULLET_MAX_LENGTH = 100

export interface OnboardingScreen {
  /** Stable id — used to key the notifications screen's extra actions. */
  id: string
  title: string
  /** Nulliel's speech-bubble line: the one thing this screen wants understood. */
  line: string
  /** Optional supporting bullets, rendered under the line. */
  bullets?: string[]
}

export const ONBOARDING_SCREENS: readonly OnboardingScreen[] = [
  {
    id: 'meet-nulliel',
    title: `Meet ${MASCOT_NAME}`,
    line: `I'm ${MASCOT_NAME} — Slipstream is your mission control for coding agents, and I'll show you around.`,
  },
  {
    id: 'core-loop',
    title: 'The core loop',
    line: 'Add a repo, launch an agent, watch it work.',
    bullets: [
      // stores.ts registerRepo()/registerRepoByUrl() -> Settings → Repositories.
      'Add a repo in Settings → Repositories.',
      // stores.ts startAgent() sets activity "Creating worktree & starting
      // claude…" — every agent gets its own fresh git worktree.
      'Each agent runs in its own fresh git worktree, so nothing collides.',
      // AgentList.svelte segs: All / Needs you / Running / Done filter chips.
      'Watch its status at a glance: running, needs you, or done.',
    ],
  },
  {
    id: 'on-your-phone',
    title: 'Working from your phone',
    line: 'Everything above works from your pocket too.',
    bullets: [
      // NewAgentFab.svelte handleClick() -> dialogOpen.set(true).
      'Tap the floating glyph to start a new agent.',
      // App.svelte listOpen / AgentList.svelte mobileOpen — drawer session list.
      'Open the drawer to jump between sessions.',
      // TerminalView.svelte toggleDiff(), the "Diff" button (desktop + mobile rows).
      'Diff shows exactly what changed before you merge.',
      // TerminalView.svelte "Hand off" button (#handoffSel / #handoffSelMob).
      'Hand off moves a stuck session to a different agent.',
    ],
  },
  {
    id: 'notifications',
    title: "Don't miss a beat",
    line: `Turn on notifications and ${MASCOT_NAME} will let you know the moment an agent needs you or finishes.`,
  },
  {
    id: 'ready',
    title: 'Ready',
    line: "That's the tour. Let's get to work.",
  },
] as const

/** Condensed bullets for the web/desktop modal — reuses the same strings as
 *  the pager screens above rather than forking new copy, so the two
 *  presentations never drift apart. */
export const ONBOARDING_MODAL_BULLETS: readonly string[] = [
  ONBOARDING_SCREENS[1].line, // core loop
  ...(ONBOARDING_SCREENS[2].bullets?.slice(2, 4) ?? []), // Diff + Hand off, from "on your phone"
  ONBOARDING_SCREENS[3].line, // notifications
]
