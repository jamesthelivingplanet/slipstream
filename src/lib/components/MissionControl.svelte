<script lang="ts">
  /**
   * Mission Control — the home view shown when no agent is selected. Surfaces
   * everything that needs attention (needs-you cards with the agent's live
   * ask), what's running, what's ready to launch from tickets, and what
   * recently landed — instead of a bare "no agent selected" empty state.
   */
  import { onMount, onDestroy } from 'svelte'
  import {
    sessions,
    tickets,
    repos,
    select,
    createAgentFromTicket,
    startAgentsFromTickets,
    dialogOpen,
    registerRepo,
    repoById,
    initialLoadLoading,
    initialLoadError,
    retryInitialLoad,
    ticketsLoading,
    ticketsTotalCount,
    ticketsPage,
    ticketsPageSize,
    ticketsHasMore,
    ticketsQuery,
    loadMoreTickets,
    setTicketsQuery,
    refreshTickets,
  } from '../stores'
  import { getSessionBuffer, hasBackend, getUsageSummary, getPrStatus } from '../ipc'
  import { extractAsk, formatWait } from '../missionControl'
  import { formatCost, formatTokens, dayKeyFromMs } from '../../../electron/shared/usageFormat.js'
  import { pushToast } from '../toast'
  import type { Session, Ticket, BackendKind } from '../types'
  import type {
    UsageSummary,
    SessionUsage,
    PrStatusDTO,
  } from '../../../electron/shared/contract.js'
import Streamlines from './Streamlines.svelte'
  import AgentSelector from './AgentSelector.svelte'
  import { icons } from '../icons'
  import NullielLoader from './NullielLoader.svelte'

  // Ticks every 30s so "waiting Xm" labels stay fresh without a full re-render trigger.
  let now = Date.now()
  let tickTimer: ReturnType<typeof setInterval> | undefined

  // FLO-94: real token/cost usage parsed from transcripts. Refreshed on mount +
  // periodically so running costs climb as agents work; gives mission control a
  // real cost signal instead of the idle reaper as a proxy.
  let usage: UsageSummary | null = null
  let usageTimer: ReturnType<typeof setInterval> | undefined
  $: usageById = new Map<string, SessionUsage>((usage?.sessions ?? []).map((s) => [s.sessionId, s]))
  $: todayCost = usage?.byDay.find((b) => b.key === dayKeyFromMs(Date.now()))?.costUsd ?? 0
  $: hasUsage = (usage?.costUsd ?? 0) > 0

  async function refreshUsage(): Promise<void> {
    if (!hasBackend) return
    try {
      usage = await getUsageSummary()
    } catch {
      // leave existing usage on failure — cost is advisory, never blocks the UI
    }
  }

  // Cache of the last-extracted "ask" per backend session id. Re-fetched only
  // when a session newly enters 'needs' (not on every store tick).
  let asks: Record<string, string | null> = {}
  const fetchedFor = new Set<string>()

  function refreshAsks(list: Session[]) {
    if (!hasBackend) return
    for (const s of list) {
      if (s.status === 'needs' && s.id && !fetchedFor.has(s.id)) {
        fetchedFor.add(s.id)
        const id = s.id
        getSessionBuffer(id)
          .then((res) => {
            asks = { ...asks, [id]: extractAsk(res.data) }
          })
          .catch(() => {
            asks = { ...asks, [id]: null }
          })
      }
    }
    // Let sessions that left 'needs' refetch cleanly if they re-enter later.
    for (const id of Array.from(fetchedFor)) {
      const s = list.find((x) => x.id === id)
      if (!s || s.status !== 'needs') fetchedFor.delete(id)
    }
  }

  $: refreshAsks($sessions)

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

  /** A done session whose PR is known but hasn't merged yet needs to read
   *  differently from one that actually landed. */
  function prNotMerged(s: Session): boolean {
    if (!s.id) return false
    const dto = prStatuses[s.id]
    return !!dto && dto.state !== 'unknown' && dto.state !== 'merged'
  }

  interface PrChip {
    text: string
    cls: 'done' | 'error' | 'needs' | 'muted'
  }

  /** Compact chip list for a session's PR: merge state, CI, review — in that
   *  order, omitting states that aren't worth a chip (none/unknown CI,
   *  none/unknown review). An error collapses to a single "PR ?" chip. */
  function prChips(dto: PrStatusDTO | undefined): PrChip[] {
    if (!dto) return []
    if (dto.error) return [{ text: 'PR ?', cls: 'muted' }]
    const chips: PrChip[] = []
    if (dto.state === 'merged') chips.push({ text: 'merged', cls: 'done' })
    else if (dto.state === 'open') chips.push({ text: 'open', cls: 'muted' })
    else if (dto.state === 'closed') chips.push({ text: 'closed', cls: 'error' })
    if (dto.ci === 'passed') chips.push({ text: 'CI ✓', cls: 'done' })
    else if (dto.ci === 'failed') chips.push({ text: 'CI ✗', cls: 'error' })
    else if (dto.ci === 'pending' || dto.ci === 'running')
      chips.push({ text: 'CI …', cls: 'needs' })
    if (dto.review === 'approved') chips.push({ text: 'approved', cls: 'done' })
    else if (dto.review === 'changes_requested') chips.push({ text: 'changes', cls: 'error' })
    return chips
  }

  $: needsSessions = $sessions.filter((s) => s.status === 'needs' || s.status === 'errored')
  $: runningSessions = $sessions.filter(
    (s) => s.status === 'running' || s.status === 'detached' || s.status === 'queued',
  )
  $: doneSessions = $sessions.filter((s) => s.status === 'done')
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

  /** Cost chip text for a session row, or null when there's no usage yet. */
  function costFor(s: Session): { cost: string; tokens: string } | null {
    if (!s.id) return null
    const u = usageById.get(s.id)
    if (!u || !u.exists || u.turns === 0) return null
    const tokens = u.tokens.input + u.tokens.output + u.tokens.cacheCreation + u.tokens.cacheRead
    return { cost: formatCost(u.costUsd), tokens: formatTokens(tokens) }
  }

  /** Mirrors NewAgentDialog's ticket → prompt convention so launching from here
   *  is equivalent to picking the ticket in the New Agent dialog. The agent
   *  used is whatever's selected in the quick-launch picker (launchAgent). */
  let launchAgent: BackendKind = 'claude-code'
  function launch(t: Ticket) {
    const prompt = `Begin implementing ${t.tid}.`
    createAgentFromTicket(t, prompt, launchAgent)
  }

  // FLO-95: batch-launch every ticket whose repo hint resolves to a registered
  // repo. Starts beyond the scheduler's concurrency cap queue and drain on
  // their own, so this is safe to fire for an arbitrary number of tickets.
  $: launchableTickets = $tickets.filter((t) => repoById(t.repo))
  // Tickets pagination reactive state
  $: ticketsLoadingState = $ticketsLoading
  $: ticketsTotalCountState = $ticketsTotalCount
  $: ticketsPageState = $ticketsPage
  $: ticketsPageSizeState = $ticketsPageSize
  $: ticketsHasMoreState = $ticketsHasMore
  $: ticketsQueryState = $ticketsQuery

  function handleTicketsSearch(query: string): void {
    setTicketsQuery(query)
  }

  async function handleLoadMoreTickets(): Promise<void> {
    await loadMoreTickets()
  }
  let launchingAll = false
  async function launchAll() {
    if (launchingAll) return
    launchingAll = true
    try {
      const n = await startAgentsFromTickets(launchableTickets, launchAgent)
      if (n > 0) {
        pushToast('success', `Launched ${n} agents — excess starts queue`)
      }
    } finally {
      launchingAll = false
    }
  }
</script>

<div class="mc">
  <Streamlines running={runningCount} needs={needsSessions.length} />

  <div class="mc-inner">
    <div class="mc-head">
      <h1>Mission control</h1>
      <span class="muted head-sum"
        >{runningCount} running · {needsSessions.length} waiting on you</span
      >
      {#if hasUsage}
        <span class="head-spend" title="Estimated from transcript usage">
          <span class="spend-today">today {formatCost(todayCost)}</span>
          <span class="muted">·</span>
          <span class="spend-total">{formatCost(usage?.costUsd ?? 0)} all time</span>
        </span>
      {/if}
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
        <button class="btn btn-primary" on:click={() => dialogOpen.set(true)}>New agent</button>
      </div>
    {:else}
      {#if needsSessions.length > 0}
        <section>
          <div class="eyebrow hot">Needs you <span class="cnt">{needsSessions.length}</span></div>
          <div class="cards">
            {#each needsSessions as s (s.id ?? s.tid)}
              <button
                type="button"
                class="card"
                class:error={s.status === 'errored'}
                on:click={() => choose(s.id)}
              >
                <div class="c-top">
                  <span class="dot" class:err={s.status === 'errored'}></span>
                  {#if s.status === 'errored'}
                    <span class="wait err">errored</span>
                  {:else if s.needsSince !== undefined}
                    <span class="wait">waiting {formatWait(s.needsSince, now)}</span>
                  {/if}
                  <span class="c-id mono">{s.tid}{s.agentKind ? ` · ${s.agentKind}` : ''}</span>
                </div>
                <div class="c-title">{s.title}</div>
                {#if s.status !== 'errored' && hasBackend && s.id && asks[s.id]}
                  <div class="ask">{asks[s.id]}</div>
                {/if}
                <div class="c-foot">
                  {#if s.branch}<span>{s.branch}</span>{/if}
                  <span class="add">+{s.add}</span>
                  <span class="del">−{s.del}</span>
                  <span class="go" class:err={s.status === 'errored'}>Answer →</span>
                </div>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if runningSessions.length > 0}
        <section>
          <div class="eyebrow">Running <span class="cnt">{runningSessions.length}</span></div>
          <div class="rows">
            {#each runningSessions as s (s.id ?? s.tid)}
              <button type="button" class="row" on:click={() => choose(s.id)}>
                <span class="dot" class:queued={s.status === 'queued'}></span>
                <span class="r-id mono">{s.tid}</span>
                <span class="r-title">{s.title}</span>
                {#if s.agentKind}<span class="chip mono">{s.agentKind}</span>{/if}
                {#if s.status === 'detached' || s.status === 'queued'}
                  <span class="r-activity muted">{s.activity.text}</span>
                {:else}
                  <span class="r-diff mono">
                    <span class="add">+{s.add}</span>
                    <span class="del">−{s.del}</span>
                    {#if s.behind > 0}
                      <span
                        class="behind"
                        title={`${s.behind} commit${s.behind === 1 ? '' : 's'} behind base`}
                        >↓{s.behind}</span
                      >
                    {/if}
                  </span>
                {/if}
                {#if costFor(s)}
                  <span
                    class="r-cost mono"
                    title={`${costFor(s)?.tokens} tokens · estimated from transcript usage`}
                    >{costFor(s)?.cost}</span
                  >
                {/if}
                {#if s.id && s.prUrl && prStatuses[s.id]}
                  <span class="pr-chips">
                    {#each prChips(prStatuses[s.id]) as c (c.text)}
                      <span class="pr-chip pr-{c.cls}" title={prStatuses[s.id]?.error}
                        >{c.text}</span
                      >
                    {/each}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if $tickets.length > 0 || ticketsLoadingState}
        <section>
          <div class="eyebrow">
            Ready to launch <span class="cnt">{$ticketsTotalCount || $tickets.length}</span>
            <div class="tickets-search">
              <input
                type="search"
                placeholder="Search tickets…"
                bind:value={ticketsQueryState}
                on:input={() => handleTicketsSearch(ticketsQueryState)}
                class="search-input"
                aria-label="Search tickets"
              />
            </div>
            <div class="quick-agent">
              <AgentSelector
                value={launchAgent}
                label="Quick-launch agent"
                on:select={(e) => (launchAgent = e.detail)}
              />
            </div>
            {#if launchableTickets.length >= 2}
              <button
                type="button"
                class="btn btn-outline btn-sm launch-all"
                disabled={launchingAll}
                on:click={launchAll}
              >
                {launchingAll ? 'Launching…' : 'Launch all →'}
              </button>
            {/if}
          </div>
          {#if ticketsLoadingState}
            <div class="tickets-loading">
              <NullielLoader size={32} caption="Loading tickets" />
            </div>
          {:else}
            <div class="tiks">
              {#each $tickets as t (t.tid)}
                <button type="button" class="tik" on:click={() => launch(t)}>
                  <span class="t-src mono">{t.tid}</span>
                  <span class="t-title">{t.title}</span>
                  <span class="launch">Launch agent →</span>
                </button>
              {/each}
            </div>
            {#if ticketsHasMoreState}
              <div class="tickets-load-more">
                <button
                  class="btn btn-outline btn-sm"
                  on:click={handleLoadMoreTickets}
                  disabled={ticketsLoadingState}
                >
                  {ticketsLoadingState ? 'Loading…' : `Load more (${$tickets.length} of {$ticketsTotalCount})`}
                </button>
              </div>
            {/if}
          {/if}
        </section>
      {/if}

      {#if doneSessions.length > 0}
        <section class="landed">
          <div class="eyebrow">Recently landed</div>
          <div class="rows">
            {#each doneSessions as s (s.id ?? s.tid)}
              <button type="button" class="row" on:click={() => choose(s.id)}>
                <span
                  class="dot"
                  class:not-merged={prNotMerged(s)}
                  title={prNotMerged(s) ? 'agent finished — PR not merged yet' : undefined}
                ></span>
                <span class="r-id mono">{s.tid}</span>
                <span class="r-title">{s.title}</span>
                {#if s.agentKind}<span class="chip mono">{s.agentKind}</span>{/if}
                {#if costFor(s)}
                  <span
                    class="r-cost mono"
                    title={`${costFor(s)?.tokens} tokens · estimated from transcript usage`}
                    >{costFor(s)?.cost}</span
                  >
                {/if}
                {#if s.id && s.prUrl && prStatuses[s.id]}
                  <span class="pr-chips">
                    {#each prChips(prStatuses[s.id]) as c (c.text)}
                      <span class="pr-chip pr-{c.cls}" title={prStatuses[s.id]?.error}
                        >{c.text}</span
                      >
                    {/each}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </section>
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

  .mc-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }
  .mc-head h1 {
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .head-sum {
    font-size: 12.5px;
  }

  .head-spend {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'Geist Mono', monospace;
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

  .eyebrow {
    font-family: 'Geist Mono', monospace;
    font-size: 10.5px;
    font-weight: 550;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: hsl(var(--muted-foreground));
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .eyebrow .cnt {
    color: hsl(var(--foreground));
  }
  .eyebrow.hot {
    color: hsl(var(--st-needs));
  }
  .eyebrow.hot .cnt {
    color: hsl(var(--st-needs));
  }
  .eyebrow::after {
    content: '';
    flex: 1;
    height: 1px;
    background: hsl(var(--border));
  }
  .eyebrow .launch-all {
    text-transform: none;
    letter-spacing: normal;
    font-weight: 550;
  }

  /* Quick-launch agent picker — reuses AgentSelector but compressed to fit
   * inline in the eyebrow header row instead of its usual card-grid size. */
  .quick-agent {
    text-transform: none;
    letter-spacing: normal;
  }
  .quick-agent :global(.agent-grid) {
    /* Flex + wrap (rather than a fixed column count) so a growing agent list
     * (now 5) stays on one row when there's room and wraps cleanly when there
     * isn't, instead of overflowing or leaving ragged empty grid cells. */
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .quick-agent :global(.agent-card) {
    flex-direction: row;
    padding: 3px 8px;
    gap: 5px;
    font-size: 11px;
  }
  .quick-agent :global(.agent-card-icon) {
    width: 15px;
    height: 15px;
  }
  .quick-agent :global(.agent-card-check) {
    display: none;
  }
  .quick-agent :global(.agent-select select) {
    height: 28px;
    font-size: 11.5px;
    padding: 0 26px 0 8px;
  }

  /* needs-you cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 12px;
  }
  .card {
    text-align: left;
    border-radius: var(--radius);
    padding: 14px 15px;
    background: hsl(var(--card));
    border: 1px solid hsl(var(--st-needs) / 0.35);
    box-shadow: 0 0 0 3px hsl(var(--st-needs) / 0.06);
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .card:hover {
    background: hsl(var(--card-hover));
    border-color: hsl(var(--st-needs) / 0.6);
  }
  .card.error {
    border-color: hsl(var(--st-error) / 0.35);
    box-shadow: 0 0 0 3px hsl(var(--st-error) / 0.06);
  }
  .card.error:hover {
    border-color: hsl(var(--st-error) / 0.6);
  }
  .c-top {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
  }
  .c-top .dot {
    width: 7px;
    height: 7px;
    border-radius: 99px;
    flex: 0 0 auto;
    background: hsl(var(--st-needs));
    animation: mc-breathe 2.4s ease-in-out infinite;
  }
  .c-top .dot.err {
    background: hsl(var(--st-error));
  }
  .wait {
    color: hsl(var(--st-needs));
    font-weight: 550;
  }
  .wait.err {
    color: hsl(var(--st-error));
  }
  .c-id {
    margin-left: auto;
    font-size: 10.5px;
    color: hsl(var(--muted-foreground));
  }
  .c-title {
    font-size: 14px;
    font-weight: 600;
  }
  .ask {
    font-family: 'Geist Mono', monospace;
    font-size: 12px;
    line-height: 1.5;
    color: hsl(var(--foreground) / 0.85);
    background: hsl(var(--muted) / 0.5);
    border-left: 2px solid hsl(var(--st-needs));
    padding: 8px 10px;
    border-radius: 0 7px 7px 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .ask::before {
    content: '❯ ';
    color: hsl(var(--st-needs));
  }
  .c-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'Geist Mono', monospace;
    font-size: 10.5px;
    color: hsl(var(--muted-foreground));
  }
  .c-foot .add {
    color: hsl(var(--st-done));
  }
  .c-foot .del {
    color: hsl(var(--st-error));
  }
  .c-foot .go {
    margin-left: auto;
    color: hsl(var(--st-needs));
    font-family: 'Geist', sans-serif;
    font-size: 11.5px;
    font-weight: 550;
  }
  .c-foot .go.err {
    color: hsl(var(--st-error));
  }

  /* running / landed rows */
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    padding: 10px 13px;
    border-radius: var(--radius);
    border: 1px solid hsl(var(--border));
    background: hsl(var(--card) / 0.75);
    width: 100%;
  }
  .row:hover {
    background: hsl(var(--card-hover));
  }
  .row .dot {
    width: 7px;
    height: 7px;
    border-radius: 99px;
    flex: 0 0 auto;
    background: hsl(var(--st-run));
    animation: mc-breathe 1.6s ease-in-out infinite;
  }
  .row .dot.queued {
    background: hsl(var(--muted-foreground));
    animation: none;
  }
  .r-id {
    font-size: 11px;
    color: hsl(var(--muted-foreground));
    width: 58px;
    flex: 0 0 auto;
  }
  .r-title {
    font-weight: 550;
    font-size: 13px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    font-size: 10.5px;
    padding: 2px 8px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
    color: hsl(var(--muted-foreground));
    flex: 0 0 auto;
  }
  .r-diff {
    font-size: 11px;
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: 6px;
  }
  .r-diff .add {
    color: hsl(var(--st-done));
  }
  .r-diff .del {
    color: hsl(var(--st-error));
  }
  .r-diff .behind {
    color: hsl(var(--st-needs));
  }
  .r-cost {
    font-size: 11px;
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: hsl(var(--muted-foreground));
    padding: 1px 7px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
  }
  .r-activity {
    font-size: 11.5px;
    flex: 0 0 auto;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* PR/CI status chips (FLO-96) */
  .pr-chips {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }
  .pr-chip {
    font-family: 'Geist Mono', monospace;
    font-size: 10.5px;
    font-weight: 550;
    padding: 1px 7px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
    color: hsl(var(--muted-foreground));
  }
  .pr-chip.pr-done {
    color: hsl(var(--st-done));
    background: hsl(var(--st-done) / 0.12);
  }
  .pr-chip.pr-error {
    color: hsl(var(--st-error));
    background: hsl(var(--st-error) / 0.12);
  }
  .pr-chip.pr-needs {
    color: hsl(var(--st-needs));
    background: hsl(var(--st-needs) / 0.12);
  }

  /* launchpad */
  .tiks {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tik {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    padding: 9px 13px;
    border-radius: var(--radius);
    border: 1px dashed hsl(var(--border));
    color: hsl(var(--foreground) / 0.9);
    width: 100%;
  }
  .tik:hover {
    border-style: solid;
    background: hsl(var(--card-hover));
  }
  .tik:hover .launch {
    opacity: 1;
  }
  .t-src {
    font-size: 10.5px;
    color: hsl(var(--primary));
    width: 58px;
    flex: 0 0 auto;
  }
  .t-title {
    font-size: 13px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .launch {
    opacity: 0;
    font-size: 11.5px;
    font-weight: 550;
    color: hsl(var(--primary));
    transition: opacity 0.12s;
  }

  /* landed */
  .landed .row {
    border-style: solid;
    opacity: 0.78;
  }
  .landed .dot {
    background: hsl(var(--st-done));
    animation: none;
  }
  /* A done session whose PR hasn't merged yet must read differently from one
     that actually landed (FLO-96). */
  .landed .dot.not-merged {
    background: hsl(var(--st-needs));
  }

  @keyframes mc-breathe {
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .c-top .dot,
    .row .dot {
      animation: none;
    }
  }
</style>
