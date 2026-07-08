<script lang="ts">
  /**
   * Run history (FLO-97) — full-pane browse of every persisted session joined
   * with its structured outcome (reported via the app MCP's report_outcome
   * tool) and transcript usage. Mirrors MissionControl's `.mc`/`.mc-inner`
   * scroll-container + eyebrow-section aesthetic so it reads as part of the
   * same app rather than a bolted-on view.
   */
  import { onMount } from 'svelte'
  import { repos, historyOpen, cleanError } from '../stores'
  import { hasBackend, listSessionHistory } from '../ipc'
  import { filterHistory, formatWhen, resultLabel } from '../history'
  import { formatCost, formatTokens } from '../../../electron/shared/usageFormat.js'
  import { icons } from '../icons'
  import type {
    SessionHistoryEntry,
    SessionUsage,
    OutcomeResult,
  } from '../../../electron/shared/contract.js'

  let entries: SessionHistoryEntry[] = []
  let loading = false
  let error: string | null = null

  // Toolbar filters. Native <select>s use '' to mean "no filter on this axis"
  // since HTML select values are always strings.
  let repoFilter = ''
  let resultFilter: '' | OutcomeResult | 'none' = ''
  let query = ''

  let expandedId: string | null = null

  // Ids (session ids) checked for compare, oldest-first. Capped at 2 — see
  // toggleCompare() for what happens when a 3rd is checked.
  let compareIds: string[] = []
  let comparing = false

  $: filtered = filterHistory(entries, {
    repoId: repoFilter || null,
    result: resultFilter || null,
    query,
  })
  $: withOutcome = entries.filter((e) => e.outcome !== null).length
  $: compareEntries = compareIds
    .map((id) => entries.find((e) => e.session.id === id))
    .filter((e): e is SessionHistoryEntry => !!e)

  async function load(): Promise<void> {
    if (!hasBackend) return
    loading = true
    error = null
    try {
      entries = await listSessionHistory()
    } catch (e) {
      error = cleanError(e)
    } finally {
      loading = false
    }
  }

  onMount(load)

  function repoLabel(repoId: string): string {
    const r = $repos.find((r) => r.id === repoId)
    return r ? `${r.org}/${r.name}` : repoId
  }

  /** Cost chip text for a row, or null when there's no billable usage yet
   *  (mirrors MissionControl's costFor()). */
  function costFor(usage: SessionUsage | null): { cost: string; tokens: string } | null {
    if (!usage || !usage.exists || usage.turns === 0) return null
    const tokens =
      usage.tokens.input + usage.tokens.output + usage.tokens.cacheCreation + usage.tokens.cacheRead
    return { cost: formatCost(usage.costUsd), tokens: formatTokens(tokens) }
  }

  function resultColor(result: OutcomeResult | null | undefined): string {
    switch (result) {
      case 'success':
        return 'hsl(var(--st-done))'
      case 'partial':
        return 'hsl(var(--st-needs))'
      case 'failure':
        return 'hsl(var(--st-error))'
      default:
        return 'hsl(var(--muted-foreground))'
    }
  }

  function toggleRow(id: string) {
    expandedId = expandedId === id ? null : id
  }

  function onRowKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleRow(id)
    }
  }

  /** Toggle a session in/out of the compare set. When a 3rd box is checked
   *  while 2 are already selected, the OLDEST selection is evicted rather than
   *  disabling the rest — checking a new box always works, and the oldest
   *  just falls off, which is simpler and more obvious than disabled inputs. */
  function toggleCompare(id: string) {
    if (compareIds.includes(id)) {
      compareIds = compareIds.filter((x) => x !== id)
      return
    }
    compareIds = compareIds.length >= 2 ? [...compareIds.slice(1), id] : [...compareIds, id]
  }

  function closeCompare() {
    comparing = false
  }
</script>

<div class="hv">
  <div class="hv-inner">
    <div class="hv-head">
      <h1>Run history</h1>
      {#if !loading && !error && entries.length > 0}
        <span class="muted head-sum">{entries.length} runs · {withOutcome} with outcomes</span>
      {/if}
      <button
        class="btn btn-ghost btn-icon btn-sm hv-close"
        title="Close history"
        aria-label="Close history"
        on:click={() => historyOpen.set(false)}
      >
        &times;
      </button>
    </div>

    {#if loading}
      <p class="muted hv-status">Loading history…</p>
    {:else if error}
      <p class="muted hv-status hv-error">{error}</p>
    {:else if entries.length === 0}
      <div class="first-run">
        <p>No runs yet — history appears after your first agent run.</p>
      </div>
    {:else if comparing && compareEntries.length === 2}
      <div class="hv-compare-view">
        <button class="btn btn-outline btn-sm hv-back" on:click={closeCompare}>
          ← Back to list
        </button>
        <div class="hv-compare-grid">
          {#each compareEntries as entry (entry.session.id)}
            {@const cost = costFor(entry.usage)}
            <div class="hv-compare-col">
              <div class="hv-compare-head">
                <span class="chip mono">{entry.session.tid}</span>
                <h3>{entry.session.title}</h3>
              </div>
              <div class="hv-compare-meta muted mono">
                <span>{repoLabel(entry.session.repoId)}</span>
                <span>{entry.session.branch}</span>
                <span>{formatWhen(entry.session.createdAt)}</span>
              </div>
              <div class="hv-result">
                <span class="hv-dot" style="background: {resultColor(entry.outcome?.result)}"
                ></span>
                {resultLabel(entry.outcome?.result)}
                {#if cost}
                  <span class="hv-cost mono" title={`${cost.tokens} tokens`}>{cost.cost}</span>
                {/if}
              </div>
              <div class="hv-detail-section">
                <div class="eyebrow">Prompt</div>
                <pre class="hv-pre">{entry.session.prompt}</pre>
              </div>
              <div class="hv-detail-section">
                <div class="eyebrow">Outcome</div>
                {#if entry.outcome}
                  <p class="hv-summary">{entry.outcome.summary}</p>
                  {#if entry.outcome.details}
                    <pre class="hv-pre">{entry.outcome.details}</pre>
                  {/if}
                {:else}
                  <p class="muted">The agent didn't report a structured outcome for this run.</p>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="hv-toolbar">
        <div class="select agent-select hv-select">
          <select aria-label="Filter by repository" bind:value={repoFilter}>
            <option value="">All repositories</option>
            {#each $repos as r (r.id)}
              <option value={r.id}>{r.org}/{r.name}</option>
            {/each}
          </select>
          <span class="chev">{@html icons.chevronDown}</span>
        </div>

        <div class="select agent-select hv-select">
          <select aria-label="Filter by outcome" bind:value={resultFilter}>
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="partial">Partial</option>
            <option value="failure">Failure</option>
            <option value="none">No outcome</option>
          </select>
          <span class="chev">{@html icons.chevronDown}</span>
        </div>

        <div class="search hv-search">
          {@html icons.search}
          <input placeholder="Search prompts & summaries…" bind:value={query} />
        </div>
      </div>

      <div class="hv-rows">
        {#each filtered as entry (entry.session.id)}
          {@const cost = costFor(entry.usage)}
          {@const expanded = expandedId === entry.session.id}
          <div class="hv-row-wrap">
            <!-- Custom row control (not <button>) because it contains nested
                 interactive children (PR link, compare checkbox) — nesting
                 interactive content inside a real <button> is invalid HTML.
                 Mirrors AgentList.svelte's role="button" row pattern. -->
            <div
              class="hv-row"
              class:expanded
              role="button"
              tabindex="0"
              on:click={() => toggleRow(entry.session.id)}
              on:keydown={(e) => onRowKeydown(e, entry.session.id)}
            >
              <span class="hv-when mono">{formatWhen(entry.session.createdAt)}</span>
              <span class="chip mono">{entry.session.tid}</span>
              <span class="hv-title">{entry.session.title}</span>
              <span class="hv-repo muted">{repoLabel(entry.session.repoId)}</span>
              {#if entry.session.branch}
                <span class="hv-branch mono muted">{entry.session.branch}</span>
              {/if}
              <span class="hv-result">
                <span class="hv-dot" style="background: {resultColor(entry.outcome?.result)}"
                ></span>
                {resultLabel(entry.outcome?.result)}
              </span>
              {#if cost}
                <span
                  class="hv-cost mono"
                  title={`${cost.tokens} tokens · estimated from transcript usage`}
                  >{cost.cost}</span
                >
              {/if}
              {#if entry.session.prUrl}
                <a
                  class="hv-pr"
                  href={entry.session.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  on:click={(e) => e.stopPropagation()}
                >
                  {@html icons.externalLink} PR
                </a>
              {/if}
              <label class="hv-compare">
                <input
                  type="checkbox"
                  checked={compareIds.includes(entry.session.id)}
                  on:click={(e) => e.stopPropagation()}
                  on:change={() => toggleCompare(entry.session.id)}
                />
                compare
              </label>
            </div>

            {#if expanded}
              <div class="hv-detail">
                <div class="hv-detail-section">
                  <div class="eyebrow">Prompt</div>
                  <pre class="hv-pre">{entry.session.prompt}</pre>
                </div>
                <div class="hv-detail-section">
                  <div class="eyebrow">Outcome</div>
                  {#if entry.outcome}
                    <p class="hv-summary">{entry.outcome.summary}</p>
                    {#if entry.outcome.details}
                      <pre class="hv-pre">{entry.outcome.details}</pre>
                    {/if}
                    <span class="muted hv-reported"
                      >reported {formatWhen(entry.outcome.reportedAt)}</span
                    >
                  {:else}
                    <p class="muted">The agent didn't report a structured outcome for this run.</p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}

        {#if filtered.length === 0}
          <p class="muted hv-status">No runs match these filters.</p>
        {/if}
      </div>
    {/if}
  </div>

  {#if compareIds.length === 2 && !comparing}
    <div class="hv-sticky">
      <button class="btn btn-primary btn-sm" on:click={() => (comparing = true)}>
        Compare 2 runs →
      </button>
    </div>
  {/if}
</div>

<style>
  .hv {
    flex: 1;
    position: relative;
    min-width: 0;
    overflow-y: auto;
  }

  .hv-inner {
    position: relative;
    max-width: 980px;
    margin: 0 auto;
    padding: 34px 36px 90px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .hv-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }
  .hv-head h1 {
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .head-sum {
    font-size: 12.5px;
  }
  .hv-close {
    margin-left: auto;
    font-size: 18px;
    line-height: 1;
  }

  .hv-status {
    font-size: 13px;
  }
  .hv-error {
    color: hsl(var(--st-error));
  }

  .first-run {
    margin: 10vh auto 0;
    max-width: 380px;
    text-align: center;
  }
  .first-run p {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    line-height: 1.55;
  }

  /* toolbar */
  .hv-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .hv-select {
    width: 200px;
    flex: 0 0 auto;
  }
  .hv-select select {
    height: 34px;
  }
  .hv-search {
    flex: 1;
    min-width: 200px;
  }

  /* rows */
  .hv-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hv-row-wrap {
    display: flex;
    flex-direction: column;
  }
  .hv-row {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    padding: 10px 13px;
    border-radius: var(--radius);
    border: 1px solid hsl(var(--border));
    background: hsl(var(--card) / 0.75);
    width: 100%;
    cursor: pointer;
  }
  .hv-row:hover {
    background: hsl(var(--card-hover));
  }
  .hv-row.expanded {
    border-color: hsl(var(--ring));
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  .hv-when {
    font-size: 11px;
    color: hsl(var(--muted-foreground));
    width: 54px;
    flex: 0 0 auto;
  }
  .chip {
    font-size: 10.5px;
    padding: 2px 8px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
    color: hsl(var(--muted-foreground));
    flex: 0 0 auto;
  }
  .hv-title {
    font-weight: 550;
    font-size: 13px;
    flex: 1 1 160px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hv-repo {
    font-size: 12px;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
  .hv-branch {
    font-size: 11px;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
  .hv-result {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: hsl(var(--foreground) / 0.85);
    flex: 0 0 auto;
  }
  .hv-dot {
    width: 7px;
    height: 7px;
    border-radius: 99px;
    flex: 0 0 auto;
  }
  .hv-cost {
    font-size: 11px;
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: hsl(var(--muted-foreground));
    padding: 1px 7px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
  }
  .hv-pr {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    font-weight: 550;
    color: hsl(var(--primary));
    flex: 0 0 auto;
  }
  .hv-pr :global(svg) {
    width: 12px;
    height: 12px;
  }
  .hv-compare {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: hsl(var(--muted-foreground));
    flex: 0 0 auto;
    cursor: pointer;
  }
  .hv-compare input {
    cursor: pointer;
  }

  .hv-detail {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 15px 16px;
    border: 1px solid hsl(var(--ring));
    border-top: none;
    border-bottom-left-radius: var(--radius);
    border-bottom-right-radius: var(--radius);
    background: hsl(var(--card) / 0.4);
  }
  .hv-detail-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hv-pre {
    font-family: 'Geist Mono', monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
    background: hsl(var(--muted) / 0.4);
    border-radius: calc(var(--radius) - 3px);
    padding: 8px 10px;
    margin: 0;
  }
  .hv-summary {
    font-size: 13px;
    line-height: 1.5;
  }
  .hv-reported {
    font-size: 11px;
  }

  .eyebrow {
    font-family: 'Geist Mono', monospace;
    font-size: 10.5px;
    font-weight: 550;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: hsl(var(--muted-foreground));
  }

  /* compare sticky bar */
  .hv-sticky {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: center;
    padding: 14px;
    background: linear-gradient(to top, hsl(var(--background)) 60%, transparent);
  }

  /* compare view */
  .hv-compare-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .hv-back {
    align-self: flex-start;
  }
  .hv-compare-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
  }
  .hv-compare-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    background: hsl(var(--card) / 0.6);
  }
  .hv-compare-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hv-compare-head h3 {
    font-size: 14px;
    font-weight: 600;
  }
  .hv-compare-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11.5px;
  }
</style>
