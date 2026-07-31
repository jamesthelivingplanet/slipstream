<script lang="ts">
  /**
   * Mission Control — the home view shown when no agent is selected. Surfaces
   * everything that needs attention (needs-you cards with the agent's live
   * ask), what's running, what's ready to launch from tickets, and what
   * recently landed — instead of a bare "no agent selected" empty state.
   *
   * The four card/row sections are child components (NeedsYouSection,
   * RunningSection, LaunchpadSection, LandedSection); this file owns the
   * cross-section state they share (session list, the ask-fetch cache, PR/
   * usage polling, and the single "which swipe row is open" value) plus the
   * deck header and first-run empty states. Pure glue (PR chips, usage
   * rollup, the ask-fetch cache guard, session lookups) lives in
   * ../missionControl.ts.
   */
  import { onMount, onDestroy } from 'svelte'
  import {
    sessions,
    tickets,
    repos,
    select,
    dialogOpen,
    chatDialogOpen,
    registerRepo,
    initialLoadLoading,
    initialLoadError,
    retryInitialLoad,
    mobile,
    cleanupAgent,
    setSessionAgent,
    setSessionStatus,
    cleanError,
  } from '../stores'
  import {
    getSessionBuffer,
    hasBackend,
    getUsageSummary,
    getPrStatus,
    writeSession,
    resumeSession,
    handoffSession,
    checkAgentCli,
  } from '../ipc'
  import {
    extractAsk,
    computeUsageRollup,
    sessionsNeedingAskFetch,
    staleAskFetchIds,
    sessionSwipeKey,
    nextHandoffFor,
  } from '../missionControl'
  import { formatCost } from '../../../electron/shared/usageFormat.js'
  import { pushToast } from '../toast'
  import { statusBucket } from '../types'
  import type { Session, BackendKind } from '../types'
  import type { UsageSummary, PrStatusDTO } from '../../../electron/shared/contract.js'
  import Streamlines from './Streamlines.svelte'
  import { icons } from '../icons'
  import { agentOption } from '../agents'
  import NeedsYouSection from './NeedsYouSection.svelte'
  import RunningSection from './RunningSection.svelte'
  import LaunchpadSection from './LaunchpadSection.svelte'
  import LandedSection from './LandedSection.svelte'

  // Ticks every 30s so "waiting Xm" labels stay fresh without a full re-render trigger.
  let now = Date.now()
  let tickTimer: ReturnType<typeof setInterval> | undefined

  // FLO-94: real token/cost usage parsed from transcripts. Refreshed on mount +
  // periodically so running costs climb as agents work; gives mission control a
  // real cost signal instead of the idle reaper as a proxy.
  let usage: UsageSummary | null = null
  let usageTimer: ReturnType<typeof setInterval> | undefined
  $: usageRollup = computeUsageRollup(usage, Date.now())
  $: usageById = usageRollup.usageById
  $: todayCost = usageRollup.todayCost
  $: hasUsage = usageRollup.hasUsage

  async function refreshUsage(): Promise<void> {
    if (!hasBackend) return
    try {
      usage = await getUsageSummary()
    } catch {
      // leave existing usage on failure — cost is advisory, never blocks the UI
    }
  }

  // Cache of the last-extracted "ask" per backend session id. Re-fetched only
  // when a session newly enters 'needs' (not on every store tick) — see
  // sessionsNeedingAskFetch/staleAskFetchIds in ../missionControl.ts.
  let asks: Record<string, string | null> = {}
  const fetchedFor = new Set<string>()

  function refreshAsks(list: Session[]) {
    if (!hasBackend) return
    for (const id of sessionsNeedingAskFetch(list, fetchedFor)) {
      fetchedFor.add(id)
      getSessionBuffer(id)
        .then((res) => {
          asks = { ...asks, [id]: extractAsk(res.data) }
        })
        .catch(() => {
          asks = { ...asks, [id]: null }
        })
    }
    // Let sessions that left 'needs' refetch cleanly if they re-enter later.
    for (const id of staleAskFetchIds(list, fetchedFor)) {
      fetchedFor.delete(id)
    }
  }

  $: refreshAsks($sessions)

  // One-tap reply chips (see suggestedReplies): sends the exact reply text
  // followed by Enter, mirroring how the terminal composer submits a line.
  // writeSession is a fire-and-forget IPC call (void, not a Promise), so
  // "failure" here means it threw synchronously (e.g. no backend/session).
  function sendReply(id: string | undefined, reply: string) {
    if (!id) return
    try {
      writeSession(id, reply + '\r')
      pushToast('success', `Sent "${reply}"`)
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : `Failed to send "${reply}"`)
    }
  }

  // FLO-96: post-handoff PR/MR status (merge/CI/review), keyed by session id.
  // Backend caches per prUrl with a TTL, so polling every session with a
  // prUrl on an interval is cheap. A session freshly gaining a prUrl (the
  // agent just opened its MR) is picked up immediately by refreshNewPrs
  // rather than waiting for the next tick.
  let prStatuses: Record<string, PrStatusDTO> = {}
  let prTimer: ReturnType<typeof setInterval> | undefined
  const prTracked = new Set<string>()
  let prNewInFlight = false

  async function fetchPr(id: string): Promise<void> {
    try {
      const dto = await getPrStatus(id)
      if (dto) prStatuses = { ...prStatuses, [id]: dto }
    } catch {
      // leave prior state — PR status is advisory, never blocks the UI
    }
  }

  async function refreshAllPrStatuses(): Promise<void> {
    if (!hasBackend) return
    const targets = $sessions.filter((s) => s.id && s.prUrl)
    await Promise.all(targets.map((s) => fetchPr(s.id as string)))
  }

  function refreshNewPrs(list: Session[]) {
    if (!hasBackend || prNewInFlight) return
    const targets = list.filter((s) => s.id && s.prUrl && !prTracked.has(s.id as string))
    if (targets.length === 0) return
    prNewInFlight = true
    Promise.all(
      targets.map((s) => {
        prTracked.add(s.id as string)
        return fetchPr(s.id as string)
      }),
    ).finally(() => {
      prNewInFlight = false
    })
  }

  $: refreshNewPrs($sessions)

  $: needsSessions = $sessions.filter((s) => statusBucket(s.status) === 'needs')
  $: runningSessions = $sessions.filter((s) => statusBucket(s.status) === 'running')
  $: doneSessions = $sessions.filter((s) => statusBucket(s.status) === 'done')
  $: runningCount = $sessions.filter((s) => s.status === 'running').length

  $: initialLoading = $initialLoadLoading
  $: initialError = $initialLoadError
  // Show onboarding only when NOT loading, NO error, and genuinely no repos
  $: showOnboarding = !initialLoading && !initialError && $repos.length === 0
  // Show retry UI when there's an error
  $: showRetry = !initialLoading && initialError
  // Show launch hint only when not loading, no error, has repos, but no sessions/tickets
  $: showLaunchHint =
    !initialLoading &&
    !initialError &&
    $repos.length > 0 &&
    $sessions.length === 0 &&
    $tickets.length === 0

  onMount(() => {
    tickTimer = setInterval(() => (now = Date.now()), 30_000)
    refreshUsage()
    // 90s keeps running spend fresh without re-scanning transcripts too often.
    usageTimer = setInterval(refreshUsage, 90_000)
    refreshAllPrStatuses()
    // 60s alongside the usage timer; the backend TTL-caches per prUrl so this stays cheap.
    prTimer = setInterval(refreshAllPrStatuses, 60_000)
  })
  onDestroy(() => {
    clearInterval(tickTimer)
    clearInterval(usageTimer)
    clearInterval(prTimer)
  })

  function choose(id: string | null | undefined) {
    if (!id) return
    select(id)
  }

  // FLO-152: swipe-to-reveal single-session actions on mobile rows/cards.
  // Only one row may be open at a time — opening another (or firing any
  // action) clears `openSwipeId`, which each SessionSwipeRow reacts to by
  // snapping shut. `handoffFor` is the session whose agent-picker menu is
  // open inside a revealed panel. Shared across all three sections that use
  // SessionSwipeRow via plain props (each section forwards its swipe events
  // back up to the handlers below, which are the single owners of this state).
  let openSwipeId: string | null = null
  let handoffFor: string | null = null
  $: swipeEnabled = $mobile && hasBackend

  function handleSwipeOpen(id: string) {
    openSwipeId = id
  }
  function handleSwipeClose(id: string) {
    if (openSwipeId === id) openSwipeId = null
  }

  /** Tear the session down (manual path: confirms first). */
  async function swipeCleanup(s: Session) {
    openSwipeId = null
    handoffFor = null
    await cleanupAgent(s, { auto: false })
  }

  /** Resume/restart the agent process in its existing worktree. */
  async function swipeRestart(s: Session) {
    openSwipeId = null
    handoffFor = null
    if (!hasBackend || !s.id) return
    try {
      await resumeSession(s.id)
      pushToast('success', `Restarted ${s.tid}.`)
    } catch (e) {
      pushToast('error', cleanError(e))
    }
  }

  function toggleHandoff(s: Session) {
    handoffFor = nextHandoffFor(handoffFor, sessionSwipeKey(s))
  }

  /** Continue the run with a different agent, keeping the worktree. */
  async function swipeHandoff(s: Session, kind: BackendKind) {
    handoffFor = null
    openSwipeId = null
    if (!hasBackend || !s.id) return
    try {
      const cli = await checkAgentCli(kind)
      if (!cli.found) {
        pushToast(
          'error',
          `${agentOption(kind).label} CLI ('${cli.bin}') was not found on the server's PATH.`,
        )
        return
      }
      await handoffSession(s.id, kind)
      setSessionAgent(s.id, kind)
      setSessionStatus(s.id, 'running')
      pushToast('success', `Run handed off to ${agentOption(kind).label}.`)
    } catch (e) {
      pushToast('error', cleanError(e))
    }
  }

  // Close any open swipe row / handoff menu when a pointer lands outside a
  // swipe row entirely (the deck, section headers, empty space). A pointer
  // that starts a drag on another row still navigates/closes naturally.
  function onWindowPointerDown(e: PointerEvent) {
    const t = e.target as HTMLElement | null
    if (!t) return
    if (handoffFor && !t.closest('.handoff-menu') && !t.closest('[data-handoff-trigger]')) {
      handoffFor = null
    }
    if (openSwipeId && !t.closest('.swipe')) {
      openSwipeId = null
    }
  }
</script>

<svelte:window on:pointerdown={onWindowPointerDown} />

<div class="mc">
  <Streamlines running={runningCount} needs={needsSessions.length} />

  <div class="mc-inner">
    <div class="deck">
      <div class="watch" class:alert={needsSessions.length > 0}>
        <img src="/icons/nulliel-glyph.svg" alt="" />
      </div>
      <div class="deck-text">
        <h1>Mission control</h1>
        <div class="readout mono">
          <span><b class="rc">{runningCount}</b> running</span><span class="sep">·</span>
          <span><b class="nc">{needsSessions.length}</b> waiting on you</span>
          {#if doneSessions.length}<span class="sep">·</span><span
              ><b>{doneSessions.length}</b> landed</span
            >{/if}
        </div>
      </div>
      <div class="deck-actions">
        {#if hasUsage}
          <span class="head-spend" title="Estimated from transcript usage">
            <span class="spend-today">today {formatCost(todayCost)}</span>
            <span class="muted">·</span>
            <span class="spend-total">{formatCost(usage?.costUsd ?? 0)} all time</span>
          </span>
        {/if}
        <!-- TASK-CIOEQ: reachable on mobile too (unlike App.svelte's header
             "New chat", which is desktop-only), since Mission Control is the
             home view on every viewport. -->
        <button
          type="button"
          class="btn btn-outline btn-sm"
          on:click={() => chatDialogOpen.set(true)}
        >
          {@html icons.chat} New chat
        </button>
      </div>
    </div>

    {#if initialLoading}
      <div class="first-run loading">
        <div class="spin" aria-label="Loading repositories and sessions...">
          {@html icons.refresh}
        </div>
        <p>Loading your repositories and agents...</p>
      </div>
    {:else if showRetry}
      <div class="first-run error">
        <h2>Couldn't load your data</h2>
        <p>{initialError}</p>
        <button class="btn btn-primary" on:click={retryInitialLoad}>Try again</button>
      </div>
    {:else if showOnboarding}
      <div class="first-run">
        <h2>Add a repository to get started</h2>
        <p>
          Slipstream runs agents inside fresh git worktrees of your repos. Add one, then start an
          agent against a ticket or a blank task.
        </p>
        <button class="btn btn-primary" on:click={() => registerRepo()}>Add repository</button>
      </div>
    {:else if showLaunchHint}
      <div class="first-run">
        <h2>No agents yet</h2>
        <p>Start one from a ticket or a blank task to see it here.</p>
        <div class="first-run-actions">
          <button class="btn btn-primary" on:click={() => dialogOpen.set(true)}>New agent</button>
          <button class="btn btn-outline" on:click={() => chatDialogOpen.set(true)}>
            {@html icons.chat} New chat
          </button>
        </div>
      </div>
    {:else}
      {#if needsSessions.length > 0}
        <NeedsYouSection
          sessions={$sessions}
          {needsSessions}
          {now}
          {asks}
          {hasBackend}
          {swipeEnabled}
          {openSwipeId}
          {handoffFor}
          onSelect={choose}
          onReply={sendReply}
          onSwipeOpen={handleSwipeOpen}
          onSwipeClose={handleSwipeClose}
          onRestart={swipeRestart}
          onCleanup={swipeCleanup}
          onToggleHandoff={toggleHandoff}
          onHandoff={swipeHandoff}
        />
      {/if}

      {#if runningSessions.length > 0}
        <RunningSection
          sessions={$sessions}
          {runningSessions}
          {usageById}
          {prStatuses}
          {swipeEnabled}
          {openSwipeId}
          {handoffFor}
          onSelect={choose}
          onSwipeOpen={handleSwipeOpen}
          onSwipeClose={handleSwipeClose}
          onRestart={swipeRestart}
          onCleanup={swipeCleanup}
          onToggleHandoff={toggleHandoff}
          onHandoff={swipeHandoff}
        />
      {/if}

      <LaunchpadSection />

      {#if doneSessions.length > 0}
        <LandedSection
          sessions={$sessions}
          {doneSessions}
          {usageById}
          {prStatuses}
          {swipeEnabled}
          {openSwipeId}
          {handoffFor}
          onSelect={choose}
          onSwipeOpen={handleSwipeOpen}
          onSwipeClose={handleSwipeClose}
          onRestart={swipeRestart}
          onCleanup={swipeCleanup}
          onToggleHandoff={toggleHandoff}
          onHandoff={swipeHandoff}
        />
      {/if}
    {/if}
  </div>
</div>

<style>
  .mc {
    flex: 1;
    position: relative;
    min-width: 0;
    overflow-y: auto;
  }

  .mc-inner {
    position: relative;
    max-width: 860px;
    margin: 0 auto;
    padding: 34px 36px 48px;
    display: flex;
    flex-direction: column;
    gap: 30px;
  }

  .deck {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 18px;
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) + 2px);
    background: hsl(var(--card) / 0.5);
  }
  .deck-text {
    min-width: 0;
  }
  .deck h1 {
    font-family: 'Chakra Petch', sans-serif;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .watch img {
    width: 44px;
    height: 44px;
    filter: drop-shadow(0 0 8px hsl(263 60% 74% / 0.55));
  }
  .watch.alert img {
    animation: watchpulse 1.9s ease-in-out infinite;
  }
  @keyframes watchpulse {
    0%,
    100% {
      filter: drop-shadow(0 0 8px hsl(263 60% 74% / 0.5));
    }
    50% {
      filter: drop-shadow(0 0 16px hsl(var(--st-error) / 0.75));
    }
  }
  .readout {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    font-variant-numeric: tabular-nums;
  }
  .readout b {
    color: hsl(var(--foreground));
    font-weight: 600;
  }
  .readout .rc {
    color: hsl(var(--st-run));
  }
  .readout .nc {
    color: hsl(var(--st-needs));
  }
  .readout .sep {
    color: hsl(var(--border));
  }

  /* TASK-CIOEQ: wraps the optional spend readout + the "New chat" button so
   * both sit flush right, whether or not hasUsage is true. */
  .deck-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .head-spend {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: hsl(var(--muted-foreground));
  }
  .head-spend .spend-today {
    color: hsl(var(--foreground));
  }

  .first-run {
    margin: 10vh auto 0;
    max-width: 380px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .first-run h2 {
    font-family: 'Chakra Petch', sans-serif;
    font-size: 16px;
    font-weight: 600;
  }
  .first-run p {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    line-height: 1.55;
  }
  .first-run .btn {
    margin-top: 6px;
  }
  .first-run-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .first-run.loading .spin {
    width: 32px;
    height: 32px;
    animation: spin 0.8s linear infinite;
    color: hsl(var(--primary));
  }
  .first-run.error {
    border: 1px solid hsl(var(--st-error) / 0.35);
    box-shadow: 0 0 0 3px hsl(var(--st-error) / 0.06);
    padding: 20px;
    border-radius: var(--radius);
    background: hsl(var(--st-error) / 0.05);
  }
  .first-run.error h2 {
    color: hsl(var(--st-error));
  }
  .first-run.error p {
    color: hsl(var(--foreground));
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .watch.alert img {
      animation: none;
    }
  }

  @media (max-width: 700px) {
    .deck {
      padding: 13px 14px;
      gap: 12px;
      flex-wrap: wrap;
      row-gap: 10px;
    }
    .watch img {
      width: 36px;
      height: 36px;
    }
    .mc-inner {
      padding: 24px 16px 40px;
    }
    .deck-actions {
      margin-left: 0;
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
