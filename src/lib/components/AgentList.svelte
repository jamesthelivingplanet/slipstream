<script lang="ts">
  import { visible, counts, filter, query, selectedId, select, repoById } from '../stores'
  import { STATUS_LABEL, type Filter } from '../types'
  import { icons } from '../icons'

  /** On mobile, controlled by parent to show/hide as drawer overlay. */
  export let mobileOpen: boolean = true
  /** Optional callback invoked after an agent is selected (e.g. to close the mobile drawer). */
  export let onSelect: (() => void) | undefined = undefined

  function choose(tid: string) {
    select(tid)
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
      <input placeholder="Search agents…" bind:value={$query} />
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
    {#each $visible as s (s.tid)}
      <div
        class="agent {s.status}"
        class:sel={$selectedId === s.tid}
        on:click={() => choose(s.tid)}
        on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && choose(s.tid)}
        role="button"
        tabindex="0"
      >
        <div class="a-top">
          <span class="stat-dot"></span>
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
          {/if}
        </div>
      </div>
    {/each}

    {#if $visible.length === 0}
      <div class="list-empty">No agents{$filter !== 'all' ? ' in this view' : ''}.</div>
    {/if}
  </div>
</aside>
