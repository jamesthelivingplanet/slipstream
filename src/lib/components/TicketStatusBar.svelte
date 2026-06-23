<script lang="ts">
  import type { Session } from '../types'
  import type { WorkflowState } from '../types'
  import { getTicketStatus, setTicketStatus, hasBackend } from '../ipc'
  import { icons } from '../icons'
  import { pushToast } from '../toast'

  export let session: Session

  let current: WorkflowState | null = null
  let available: WorkflowState[] = []
  let hidden = false
  let menuOpen = false
  let lastTid = ''

  $: isBlank = session.tid.startsWith('TASK-')
  $: shouldShow = !isBlank && hasBackend

  $: if (shouldShow && session.tid !== lastTid) {
    lastTid = session.tid
    hidden = false
    current = null
    available = []
    menuOpen = false
    getTicketStatus(session.tid)
      .then((res) => {
        if (res.available.length === 0) {
          hidden = true
        } else {
          current = res.current
          available = res.available
        }
      })
      .catch(() => {
        hidden = true
      })
  }

  async function selectState(state: WorkflowState) {
    const prev = current
    current = state
    menuOpen = false
    try {
      const updated = await setTicketStatus(session.tid, state.id)
      current = updated
    } catch (e) {
      current = prev
      pushToast('error', e instanceof Error ? e.message : 'Failed to update status')
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (menuOpen && !(e.target as HTMLElement).closest('#ticketStatusSel')) menuOpen = false
  }
</script>

<svelte:window on:click={onWindowClick} />

{#if shouldShow && !hidden && available.length > 0}
  <div class="status-bar">
    <span class="ticket-id mono">{session.tid}</span>
    <span class="ticket-title">{session.title}</span>
    <div class="spacer"></div>
    <div class="select" id="ticketStatusSel">
      <button class="sel-trigger status-trigger" type="button" on:click|stopPropagation={() => (menuOpen = !menuOpen)}>
        <span>{current?.name ?? 'Set status'}</span>
        <span class="chev">{@html icons.chevronDown}</span>
      </button>
      {#if menuOpen}
        <div class="sel-menu sel-menu-right">
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
</style>
