<script lang="ts">
  import { onMount } from 'svelte'
  import { hasBackend } from '../ipc'
  import { cliStatus, cliChecking, refreshCliStatus } from '../stores'

  let open = false

  function onWindowClick(e: MouseEvent) {
    if (open && !(e.target as HTMLElement).closest('.pop-wrap')) open = false
  }

  onMount(() => {
    if (hasBackend) refreshCliStatus()
  })

  function relTime(ms: number): string {
    const diff = Math.max(0, Date.now() - ms)
    const sec = Math.round(diff / 1000)
    if (sec < 5) return 'just now'
    if (sec < 60) return `${sec}s`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m`
    const hr = Math.round(min / 60)
    if (hr < 24) return `${hr}h`
    const day = Math.round(hr / 24)
    return `${day}d`
  }

  $: state =
    $cliStatus === null ? ($cliChecking ? 'checking' : 'unknown') : $cliStatus.up ? 'up' : 'down'
  $: dotLabel = state === 'up' ? 'CLI: up' : state === 'down' ? 'CLI: unreachable' : 'CLI: checking'
</script>

<svelte:window on:click={onWindowClick} />

<div class="pop-wrap mcp-status">
  <button
    class="btn btn-ghost btn-icon btn-sm"
    title={dotLabel}
    aria-label={dotLabel}
    on:click|stopPropagation={() => (open = !open)}
  >
    <span
      class="mcp-dot"
      class:up={state === 'up'}
      class:down={state === 'down'}
      class:checking={state === 'checking' || state === 'unknown'}
    ></span>
  </button>

  {#if open}
    <div class="pop mcp-pop">
      <div class="mcp-head">
        <span
          class="mcp-dot"
          class:up={state === 'up'}
          class:down={state === 'down'}
          class:checking={state === 'checking' || state === 'unknown'}
        ></span>
        <span class="mcp-title">slipstream CLI</span>
        <span class="mcp-state"
          >{state === 'up' ? 'Up' : state === 'down' ? 'Unreachable' : 'Checking'}</span
        >
      </div>

      {#if $cliStatus?.commands?.length}
        <div class="mcp-tools">
          {#each $cliStatus.commands as command (command)}
            <span class="mcp-tool mono">{command}</span>
          {/each}
        </div>
      {/if}

      {#if $cliStatus}
        <div class="mcp-line muted">Checked {relTime($cliStatus.checkedAt)} ago</div>
        {#if $cliStatus.lastActivityAt}
          <div class="mcp-line muted">Last used {relTime($cliStatus.lastActivityAt)} ago</div>
        {:else}
          <div class="mcp-line muted">No agent has used it yet</div>
        {/if}
      {/if}

      {#if $cliStatus?.error}
        <div class="mcp-error">{$cliStatus.error}</div>
      {/if}

      <button
        class="btn btn-outline btn-sm mcp-recheck"
        on:click={() => refreshCliStatus()}
        disabled={$cliChecking}
      >
        {$cliChecking ? 'Checking…' : 'Recheck'}
      </button>
    </div>
  {/if}
</div>

<style>
  .mcp-dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: hsl(var(--muted-foreground));
  }
  .mcp-dot.up {
    background: hsl(var(--st-done));
  }
  .mcp-dot.down {
    background: hsl(var(--st-error));
  }
  .mcp-dot.checking {
    background: hsl(var(--st-needs));
    animation: mcp-pulse 1.6s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .mcp-dot.checking {
      animation: none;
    }
  }
  @keyframes mcp-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .mcp-pop {
    width: 240px;
    left: 0;
    right: auto;
  }

  .mcp-head {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
  }
  .mcp-title {
    font-size: 12.5px;
    font-weight: 600;
  }
  .mcp-state {
    margin-left: auto;
    font-size: 11px;
    color: hsl(var(--muted-foreground));
  }


  .mcp-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 8px;
  }
  .mcp-tool {
    font-size: 10.5px;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid hsl(var(--border));
    color: hsl(var(--muted-foreground));
  }

  .mcp-line {
    font-size: 11.5px;
    margin-bottom: 2px;
  }

  .mcp-error {
    font-size: 11.5px;
    color: hsl(var(--st-error));
    margin-top: 4px;
    margin-bottom: 4px;
    word-break: break-word;
  }

  .mcp-recheck {
    width: 100%;
    margin-top: 8px;
  }
</style>
