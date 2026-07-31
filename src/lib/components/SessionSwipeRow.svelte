<script lang="ts">
  /**
   * SessionSwipeRow — the swipe-to-reveal action wrapper (restart / hand off /
   * cleanup) shared by Mission Control's needs-you cards, running rows, and
   * landed rows. Extracted verbatim from MissionControl.svelte (FLO-152 swipe
   * actions), which previously repeated this exact block three times.
   *
   * `openSwipeId`/`handoffFor` are cross-section shared state owned by the
   * parent (only one row across the WHOLE page may be open at a time) — this
   * component only reads them and reports intent via events; it never owns
   * them itself.
   */
  import { createEventDispatcher } from 'svelte'
  import SwipeActions from './SwipeActions.svelte'
  import { floatingAnchor } from '../floating'
  import { icons } from '../icons'
  import { AGENTS } from '../agents'
  import type { Session, BackendKind } from '../types'

  export let session: Session
  export let swipeKey: string
  export let swipeEnabled: boolean
  export let openSwipeId: string | null
  export let handoffFor: string | null

  const dispatch = createEventDispatcher<{
    open: { id: string }
    close: { id: string }
    restart: void
    cleanup: void
    togglehandoff: void
    handoff: { kind: BackendKind }
  }>()

  /** Agents this run could be handed off to (every kind except the current). */
  $: handoffTargets = AGENTS.filter((a) => a.kind !== (session.agentKind ?? 'claude-code'))
</script>

<SwipeActions
  id={swipeKey}
  enabled={swipeEnabled}
  openId={openSwipeId}
  on:open={(e) => dispatch('open', { id: e.detail.id })}
  on:close={(e) => dispatch('close', { id: e.detail.id })}
>
  <svelte:fragment slot="left">
    <button
      type="button"
      class="swipe-act restart"
      title="Restart agent"
      on:click|stopPropagation={() => dispatch('restart')}
      >{@html icons.refresh}<span class="lbl">Restart</span></button
    >
    <div class="swipe-handoff">
      <button
        type="button"
        class="swipe-act handoff"
        data-handoff-trigger
        title="Hand off to another agent"
        on:click|stopPropagation={() => dispatch('togglehandoff')}
        >{@html icons.arrowRightLeft}<span class="lbl">Hand off</span></button
      >
      {#if handoffFor === swipeKey}
        <div class="handoff-menu" use:floatingAnchor>
          {#each handoffTargets as agent (agent.kind)}
            <button
              type="button"
              class="opt"
              on:click|stopPropagation={() => dispatch('handoff', { kind: agent.kind })}
            >
              <span>Hand off to {agent.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </svelte:fragment>
  <svelte:fragment slot="right">
    <button
      type="button"
      class="swipe-act danger"
      title="Clean up agent"
      on:click|stopPropagation={() => dispatch('cleanup')}
      >{@html icons.trash}<span class="lbl">Cleanup</span></button
    >
  </svelte:fragment>
  <slot />
</SwipeActions>

<style>
  /* FLO-152: swipe-to-reveal action buttons behind a row/card. */
  .swipe-act {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-width: 64px;
    padding: 0 10px;
    border: none;
    background: transparent;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
    -webkit-tap-highlight-color: transparent;
  }
  .swipe-act :global(svg) {
    width: 18px;
    height: 18px;
  }
  .swipe-act.restart {
    background: hsl(var(--primary) / 0.16);
    color: hsl(var(--primary));
  }
  .swipe-act.handoff {
    background: hsl(var(--muted) / 0.55);
    color: hsl(var(--foreground));
  }
  .swipe-act.danger {
    background: hsl(var(--st-error) / 0.16);
    color: hsl(var(--st-error));
  }
  .swipe-act:active {
    filter: brightness(0.92);
  }

  /* Hand-off target picker — portaled to <body> by floatingAnchor so it
     escapes the short, overflow-clipped row. Mirrors the app's sel-menu. */
  .swipe-handoff {
    position: relative;
    display: flex;
  }
  :global(.handoff-menu) {
    z-index: 80;
    padding: 5px;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    min-width: 180px;
    animation: pop 0.14s ease;
  }
  :global(.handoff-menu .opt) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: calc(var(--radius) - 3px);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    width: 100%;
    background: transparent;
    border: none;
    color: hsl(var(--foreground));
    text-align: left;
  }
  :global(.handoff-menu .opt:hover) {
    background: hsl(var(--accent-bg));
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
