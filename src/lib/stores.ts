// Barrel: `src/lib/stores.ts` and the `src/lib/stores/` directory coexist —
// this file re-exports the full public surface so every existing `from
// './stores'` / `from '../stores'` import keeps resolving unchanged. Do NOT
// add a `stores/index.ts`; that would make `./stores` ambiguous between the
// file and the directory. Implementations live in the focused modules below;
// this file holds no logic of its own beyond re-exporting.

export { sessionsToReconcile } from './reconcile'
export { isStartableTicket } from './ticketFilter.js'
export * from './stores/confirmDialog.js'
export { cleanError } from './stores/errors.js'
export * from './stores/cliStatus.js'
export * from './stores/reviewComments.js'
export {
  runningApps,
  appRunKey,
  appUrls,
  stopAppForSession,
  refreshAppStatus,
} from './stores/appRunner.js'

// UI state: selection, filters, dialog/panel toggles, viewport sync, and the
// derived selected/counts/visible views over `sessions`.
export {
  selectedId,
  filter,
  query,
  dialogOpen,
  chatDialogOpen,
  settingsOpen,
  settingsRepoId,
  historyOpen,
  bootingId,
  mobile,
  keyboardInset,
  drawer,
  connected,
  contentLoading,
  contentResolvedAt,
  contentRefreshNonce,
  selected,
  counts,
  visible,
  select,
  openAgentById,
} from './stores/ui.js'

// Repos: the registered-repo list and its CRUD actions.
export {
  repos,
  repoById,
  openRepoSettings,
  registerRepo,
  registerRepoByPath,
  registerRepoByUrl,
  removeRepoById,
} from './stores/repos.js'

// Tickets: the paged ticket list and its query/paging actions.
export {
  tickets,
  ticketsTotalCount,
  ticketsPage,
  ticketsPageSize,
  ticketsHasMore,
  ticketsLoading,
  ticketsQuery,
  refreshTickets,
  loadMoreTickets,
  setTicketsQuery,
} from './stores/tickets.js'

// Sessions: the session list, the SessionDTO->Session mapper, and every
// session lifecycle action (draft creation, start, status, cleanup, app run).
export {
  sessions,
  SESSION_DTO_FIELD_KEYS,
  SRC_LABELS,
  dtoToSession,
  updateDraftPrompt,
  createAgentFromTicket,
  createBlankAgent,
  discardDraft,
  startAgent,
  startChatAgent,
  startAgentsFromTickets,
  setSessionPrUrl,
  setSessionAgent,
  setSessionStatus,
  markSessionInput,
  removeSession,
  resolveNeedsInput,
  cleanupAgent,
  updateAgentFromBase,
  refreshDiffStats,
  runAppForSession,
  restartAppForSession,
} from './stores/sessions.js'

// Init + subscriptions: seeding stores from the backend on boot, and mirroring
// live backend broadcasts (status/PR/connection) into the stores above.
export {
  initFromBackend,
  initialLoadLoading,
  initialLoadError,
  retryInitialLoad,
  refreshAndReconcile,
  subscribeSessionStatus,
  subscribeSessionPr,
  subscribeConnectionChange,
} from './stores/init.js'
