<script lang="ts">
  import { visible, counts, filter, query, selectedId, select, repoById } from '../stores'
  import { STATUS_LABEL, type Filter } from '../types'
  import { icons } from '../icons'
  import NullielLoader from './NullielLoader.svelte'
  import NullielTrio from './NullielTrio.svelte'

  /** On mobile, controlled by parent to show/hide as drawer overlay. */
  export let mobileOpen: boolean = true
  /** Optional callback invoked after an agent is selected (e.g. to close the mobile drawer). */
  export let onSelect: (() => void) | undefined = undefined

  function choose(id: string | undefined) {
    if (!id) return
    select(id)
    onSelect?.()
  }

  const segs: { f: Filter; label: string }[] = [
    { f: 'all', label: 'All' },
    { f: 'needs', label: 'Needs you' },
    { f: 'running', label: 'Running' },
    { f: 'done', label: 'Done' },
  ]
</script>

<aside class="list-pane" class:open={mobileOpen}>
  <div class="list-top">
    <div class="row1">
      <h2>Agents</h2>
      <span class="count muted">· {$counts.all}</span>
    </div>

    <div class="search">
      {@html icons.search}
      <input placeholder="Search agents…" aria-label="Search agents" bind:value={$query} />
      {#if $query}
        <button
          type="button"
          class="search-clear"
          aria-label="Clear search"
          on:click={() => query.set('')}
        >
          {@html icons.close}
        </button>
      {/if}
    </div>

    <div class="segs">
      {#each segs as s (s.f)}
        <button
          type="button"
          class="seg"
          class:on={$filter === s.f}
          on:click={() => filter.set(s.f)}
        >
          {s.label}
          {#if s.f !== 'all' && $counts[s.f]}<span class="n">{$counts[s.f]}</span>{/if}
          {#if s.f === 'all'}<span class="n">{$counts.all}</span>{/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="agents">
    {#each $visible as s (s.id)}
      <div
        class="agent {s.status}"
        class:sel={$selectedId === s.id}
        on:click={() => choose(s.id)}
        on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && choose(s.id)}
        role="button"
        tabindex="0"
      >
        <div class="a-top">
          {#if s.status === 'tearing-down'}
            <span class="td-loader" title="Tearing down">
              <NullielLoader size={14} />
            </span>
          {:else if s.status === 'running'}
            <span class="run-loader" title="Running">
              <NullielTrio size={10} />
            </span>
          {:else}
            <span class="stat-dot"></span>
          {/if}
          <span class="a-status">{STATUS_LABEL[s.status]}</span>
          <span class="a-id mono">{s.tid}</span>
        </div>
        <div class="a-title">{s.title}</div>
        <div class="a-meta">
          {#if !s.repo}
            <span class="muted">draft · pick a repo to start</span>
          {:else}
            {@const r = repoById(s.repo)}
            <span class="b mono"
              >{@html icons.folder}<span class="br">{r?.org}/{r?.name}</span></span
            >
            <span class="b mono"
              >{@html icons.gitBranch}<span class="br">{s.branch?.replace(s.tid + '-', '')}</span
              ></span
            >
            <span class="diff mono"
              ><span class="add">+{s.add}</span><span class="del">−{s.del}</span></span
            >
            {#if s.reconcileWarning}
              <span class="warn-badge" title={s.reconcileWarning}>⚠ not clean</span>
            {/if}
          {/if}
        </div>
      </div>
    {/each}

    {#if $visible.length === 0}
      <div class="list-empty">No agents{$filter !== 'all' ? ' in this view' : ''}.</div>
    {/if}
  </div>
</aside>

<style>
  /* TASK-RAHTX: a tearing-down agent shows the Nulliel loader in place of its
   * status dot and dims the row while cleanup finishes. The "Tearing down"
   * label itself comes from STATUS_LABEL via the shared .a-status style. */
  .agent.tearing-down {
    opacity: 0.62;
    pointer-events: none;
  }
  .td-loader {
    display: inline-flex;
    align-items: center;
    flex: 0 0 7px;
    width: 7px;
    height: 7px;
  }
  /* Running rows swap the breathing .stat-dot for a three-glyph "dancing"
   * indicator (NullielTrio). Wider than the 7px dot, so give it its own
   * non-shrinking flex basis rather than trying to force it into 7px. */
  .run-loader {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
  }
</style>
