<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Session } from '../types'
  import type { WorkflowState } from '../types'
  import { getTicketStatus, setTicketStatus, hasBackend } from '../ipc'
  import { icons } from '../icons'
  import { floatingAnchor } from '../floating'
  import { pushToast } from '../toast'
  import { contentLoading, contentResolvedAt, contentRefreshNonce } from '../stores'

  export let session: Session

  let current: WorkflowState | null = null
  let available: WorkflowState[] = []
  let loading = false
  let error: string | null = null
  let menuOpen = false
  let lastTid = ''
  let lastNonce = 0

  $: isBlank = session.tid.startsWith('TASK-')
  $: shouldShow = !isBlank && hasBackend

  function fetchStatus() {
    loading = true
    error = null
    menuOpen = false
    contentLoading.set(true)
    getTicketStatus(session.tid, session.src)
      .then((res) => {
        current = res.current
        available = res.available
        contentResolvedAt.set(Date.now())
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : 'Failed to load status'
      })
      .finally(() => {
        loading = false
        contentLoading.set(false)
      })
  }

  $: if (shouldShow && session.tid !== lastTid) {
    lastTid = session.tid
    fetchStatus()
  }

  $: if (shouldShow && $contentRefreshNonce !== lastNonce) {
    lastNonce = $contentRefreshNonce
    fetchStatus()
  }

  onDestroy(() => contentLoading.set(false))

  async function selectState(state: WorkflowState) {
    const prev = current
    current = state
    menuOpen = false
    try {
      const updated = await setTicketStatus(session.tid, state.id, session.src)
      current = updated
    } catch (e) {
      current = prev
      pushToast('error', e instanceof Error ? e.message : 'Failed to update status')
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (menuOpen && !(e.target as HTMLElement).closest('#ticketStatusSel')) menuOpen = false
  }

  function onTriggerClick() {
    if (!error && available.length > 0) menuOpen = !menuOpen
  }
</script>

<svelte:window on:click={onWindowClick} />

{#if shouldShow}
  <div class="status-bar">
    <span class="ticket-id mono">{session.tid}</span>
    <span class="ticket-title">{session.title}</span>
    <div class="spacer"></div>
    <div class="select" id="ticketStatusSel">
      {#if loading && !current && available.length === 0}
        <button class="sel-trigger status-trigger" type="button" disabled>
          <span class="muted">Loading…</span>
          <span class="chev">{@html icons.chevronDown}</span>
        </button>
      {:else if error}
        <button class="sel-trigger status-trigger" type="button" disabled title={error}>
          <span class="muted">Status unavailable</span>
          <span class="chev">{@html icons.chevronDown}</span>
        </button>
      {:else if available.length === 0}
        <button class="sel-trigger status-trigger" type="button" disabled>
          <span class="muted">{current?.name ?? 'No statuses'}</span>
          <span class="chev">{@html icons.chevronDown}</span>
        </button>
      {:else}
        <button
          class="sel-trigger status-trigger"
          type="button"
          on:click|stopPropagation={onTriggerClick}
        >
          <span>{current?.name ?? 'Set status'}</span>
          <span class="chev">{@html icons.chevronDown}</span>
        </button>
        {#if menuOpen}
          <div class="sel-menu sel-menu-right" use:floatingAnchor>
            {#each available as state (state.id)}
              <button
                type="button"
                class="opt"
                class:sel={current?.id === state.id}
                on:click={() => selectState(state)}
              >
                <span>{state.name}</span>
                <span class="check">{@html icons.check}</span>
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    height: 40px;
    flex: 0 0 40px;
    border-bottom: 1px solid hsl(var(--border));
    font-size: 13px;
  }
  .ticket-id {
    color: hsl(var(--muted-foreground));
    font-size: 12px;
    white-space: nowrap;
  }
  .ticket-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: hsl(var(--foreground));
  }
  .spacer {
    flex: 1;
  }
  .status-trigger {
    height: 28px;
    font-size: 12px;
    padding: 0 10px;
    width: auto;
    min-width: 100px;
  }
  .sel-menu-right {
    left: auto;
    right: 0;
    min-width: 160px;
  }
  .muted {
    color: hsl(var(--muted-foreground));
  }
</style>
