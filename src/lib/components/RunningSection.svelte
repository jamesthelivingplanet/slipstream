<script lang="ts">
  /**
   * Mission Control's "Running" row list. Extracted verbatim from
   * MissionControl.svelte.
   */
  import {
    costFor,
    prChips,
    findParentTitle,
    countSpawned,
    sessionSwipeKey,
  } from '../missionControl'
  import SessionSwipeRow from './SessionSwipeRow.svelte'
  import type { Session, BackendKind } from '../types'
  import type { SessionUsage, PrStatusDTO } from '../../../electron/shared/contract.js'

  export let sessions: Session[] // all known sessions, for parent/spawned lookups
  export let runningSessions: Session[]
  export let usageById: Map<string, SessionUsage>
  export let prStatuses: Record<string, PrStatusDTO>
  export let swipeEnabled: boolean
  export let openSwipeId: string | null
  export let handoffFor: string | null
  export let onSelect: (id: string | null | undefined) => void
  export let onSwipeOpen: (id: string) => void
  export let onSwipeClose: (id: string) => void
  export let onRestart: (s: Session) => void
  export let onCleanup: (s: Session) => void
  export let onToggleHandoff: (s: Session) => void
  export let onHandoff: (s: Session, kind: BackendKind) => void
</script>

<section>
  <div class="eyebrow">Running <span class="cnt">{runningSessions.length}</span></div>
  <div class="rows">
    {#each runningSessions as s (s.id ?? s.tid)}
      <SessionSwipeRow
        session={s}
        swipeKey={sessionSwipeKey(s)}
        {swipeEnabled}
        {openSwipeId}
        {handoffFor}
        on:open={(e) => onSwipeOpen(e.detail.id)}
        on:close={(e) => onSwipeClose(e.detail.id)}
        on:restart={() => onRestart(s)}
        on:cleanup={() => onCleanup(s)}
        on:togglehandoff={() => onToggleHandoff(s)}
        on:handoff={(e) => onHandoff(s, e.detail.kind)}
      >
        <button type="button" class="row" on:click={() => onSelect(s.id)}>
          <span class="dot" class:queued={s.status === 'queued'}></span>
          <span class="r-id mono">{s.tid}</span>
          <span class="r-title">{s.title}</span>
          {#if findParentTitle(sessions, s.parentId)}
            <span
              class="chip mono spawned-chip"
              title={`Spawned by ${findParentTitle(sessions, s.parentId)}`}
              >↳ {findParentTitle(sessions, s.parentId)}</span
            >
          {/if}
          {#if countSpawned(sessions, s.id) > 0}
            <span class="chip mono">{countSpawned(sessions, s.id)} spawned</span>
          {/if}
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
          {#if s.id && costFor(usageById.get(s.id))}
            <span
              class="r-cost mono"
              title={`${costFor(usageById.get(s.id))?.tokens} tokens · estimated from transcript usage`}
              >{costFor(usageById.get(s.id))?.cost}</span
            >
          {/if}
          {#if s.id && s.prUrl && prStatuses[s.id]}
            <span class="pr-chips">
              {#each prChips(prStatuses[s.id]) as c (c.text)}
                <span class="pr-chip pr-{c.cls}" title={prStatuses[s.id]?.error}>{c.text}</span>
              {/each}
            </span>
          {/if}
        </button>
      </SessionSwipeRow>
    {/each}
  </div>
</section>

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

  /* running rows */
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
    animation: breathe 2.2s ease-in-out infinite;
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
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
    color: hsl(var(--muted-foreground));
    flex: 0 0 auto;
  }
  /* TASK-CIOEQ: the "↳ spawned by" chip on running/landed rows — truncate so
   * a long parent title can't blow out the row layout. */
  .spawned-chip {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    font-size: 12px;
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
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
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

  @media (prefers-reduced-motion: reduce) {
    .row .dot {
      animation: none;
    }
  }
</style>
