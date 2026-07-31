<script lang="ts">
  /**
   * Mission Control's "Ready to launch" ticket launchpad. Extracted verbatim
   * from MissionControl.svelte — fully self-contained (owns its own
   * quick-launch agent selection and pagination wiring) since nothing outside
   * this section reads `launchAgent`.
   *
   * FLO-95: batch-launch every ticket whose repo hint resolves to a
   * registered repo. Starts beyond the scheduler's concurrency cap queue and
   * drain on their own, so this is safe to fire for an arbitrary number of
   * tickets.
   */
  import {
    tickets,
    repoById,
    ticketsLoading,
    ticketsTotalCount,
    ticketsPage,
    ticketsHasMore,
    ticketsQuery,
    loadMoreTickets,
    setTicketsQuery,
    refreshTickets,
    createAgentFromTicket,
    startAgentsFromTickets,
  } from '../stores'
  import { pushToast } from '../toast'
  import { icons } from '../icons'
  import type { Ticket, BackendKind } from '../types'
  import AgentSelector from './AgentSelector.svelte'
  import NullielLoader from './NullielLoader.svelte'
  import SearchInput from './SearchInput.svelte'

  /** Mirrors NewAgentDialog's ticket → prompt convention so launching from
   *  here is equivalent to picking the ticket in the New Agent dialog. */
  let launchAgent: BackendKind = 'claude-code'
  function launch(t: Ticket) {
    const prompt = `Begin implementing ${t.tid}.`
    createAgentFromTicket(t, prompt, launchAgent)
  }

  $: launchableTickets = $tickets.filter((t) => repoById(t.repo))

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

{#if $tickets.length > 0 || $ticketsLoading}
  <section>
    <div class="eyebrow">
      Ready to launch <span class="cnt">{$ticketsTotalCount || $tickets.length}</span>
      <div class="tickets-search">
        <SearchInput
          value={$ticketsQuery}
          onInput={handleTicketsSearch}
          placeholder="Search tickets…"
          ariaLabel="Search tickets"
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
    {#if $ticketsLoading}
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
      {#if $ticketsHasMore || $ticketsPage > 1}
        <div class="tickets-pagination">
          <button
            class="btn btn-outline btn-sm"
            on:click={() => {
              if ($ticketsPage > 1) {
                ticketsPage.set($ticketsPage - 1)
                refreshTickets()
              }
            }}
            disabled={$ticketsLoading || $ticketsPage <= 1}
            aria-label="Previous page"
          >
            {@html icons.chevronLeft}
          </button>
          <span class="page-info">Page {$ticketsPage}</span>
          <button
            class="btn btn-outline btn-sm"
            on:click={handleLoadMoreTickets}
            disabled={$ticketsLoading || !$ticketsHasMore}
            aria-label="Next page"
          >
            {@html icons.chevronRight}
          </button>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
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

  .tickets-search {
    flex: 1;
    min-width: 180px;
    max-width: 300px;
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
    font-size: 12px;
    padding: 0 26px 0 8px;
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
    font-size: 11px;
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
    font-size: 12px;
    font-weight: 550;
    color: hsl(var(--primary));
    transition: opacity 0.12s;
  }
</style>
