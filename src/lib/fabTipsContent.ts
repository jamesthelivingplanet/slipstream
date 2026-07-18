// Copy for the mobile FAB's occasional tip bubble (TASK-I9S44, "Clippy
// mode"). Every tip below names a feature that actually exists and is
// reachable from the mobile layout — verified against the component that
// implements it (see the comment beside each entry). No invented features,
// keybindings, or gestures. The oracle-flavored intro label (FAB_TIP_INTROS,
// TASK-F0TYG) is static-per-bubble UI chrome rendered by NewAgentFab.svelte,
// not baked into the tip text — keeps the tip body itself plain and
// practical per the brief.

/** Hard cap enforced by fabTipsContent.test.ts — keeps every tip readable in
 *  the small pixel-bordered bubble on a phone width without wrapping into a
 *  wall of text. */
export const FAB_TIP_MAX_LENGTH = 120

/** Hard cap for a tip-bubble intro — short enough that it never wraps above
 *  the tip body it introduces. */
export const FAB_TIP_INTRO_MAX_LENGTH = 40

/** Nulliel-voiced lead-ins shown above the tip body (replaces the old static
 *  "the angel observes" chrome). Paired with the current tip index in
 *  NewAgentFab.svelte so the intro rotates together with the tip and stays
 *  stable while a single bubble is showing. */
export const FAB_TIP_INTROS: readonly string[] = [
  'Nulliel drifts closer',
  'Nulliel has a tip',
  'a transmission from Nulliel',
  'Nulliel noticed something',
  'psst — Nulliel here',
]

export const FAB_TIPS: readonly string[] = [
  // Settings → Notifications (SettingsNotifications.svelte) — native push via
  // FCM inside the Capacitor shell, Web Push in the installed PWA.
  "Turn on notifications in Settings so you'll know the moment an agent needs you or finishes.",

  // New Agent dialog "Save as template" (NewAgentDialog.svelte, saveTemplate()).
  'Save a prompt as a template when starting a new agent — reuse it next time.',

  // Header "History" button -> historyOpen -> HistoryView.svelte (always
  // visible in the mobile header, App.svelte).
  'Tap History in the header to revisit past agent runs.',

  // TerminalView "Hand off" button — has a dedicated mobile control
  // (#handoffSelMob) alongside the desktop one.
  'When a session hits its limits, use Hand off to continue the work with a different agent.',

  // TerminalView handleUpdateFromBase(), shown when session.behind > 0 —
  // reachable on mobile via the session's "More actions" (•••) menu.
  'Branch behind base? Update from base can rebase or merge it in one tap.',

  // SettingsRepositories.svelte addByUrl() / registerRepoByUrl.
  'Add a repo by pasting its Git remote URL in Settings → Repositories.',

  // SettingsServer.svelte — only rendered when nativeStorage.isAvailable(),
  // i.e. inside the Capacitor mobile app itself.
  'Settings → Server lets you point this app at a different Slipstream daemon.',

  // SettingsBehavior.svelte "Concurrency" section (schedPolicy.maxConcurrent).
  'Cap how many agents run at once in Settings → Behavior → Concurrency.',

  // SettingsBehavior.svelte "Session cleanup (cost guard)" section.
  'Settings → Behavior can auto-stop idle or abandoned sessions to save compute.',

  // SettingsBehavior.svelte mobileEditorCommand field.
  'Set a mobile editor command in Settings → Behavior to open worktrees from your phone.',

  // TerminalView toggleDiff() "Diff" button — present in both the desktop
  // and the {#if $mobile} action rows.
  'Tap Diff on a session to review changes and leave inline comments before merging.',

  // ThemeMenu.svelte (mode + accent swatches), always in the header.
  'The palette icon in the header switches light/dark mode and the accent color.',
] as const
