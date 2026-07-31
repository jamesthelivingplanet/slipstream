<script lang="ts">
  /**
   * Mission Control's "Needs you" card grid — sessions in the 'needs' bucket,
   * each surfacing the agent's live extracted ask (see missionControl.ts's
   * extractAsk) and one-tap suggested replies. Extracted verbatim from
   * MissionControl.svelte.
   */
  import { formatWait, suggestedReplies, findParentTitle, countSpawned } from '../missionControl'
  import { sessionSwipeKey } from '../missionControl'
  import SessionSwipeRow from './SessionSwipeRow.svelte'
  import type { Session, BackendKind } from '../types'

  export let sessions: Session[] // all known sessions, for parent/spawned lookups
  export let needsSessions: Session[]
  export let now: number
  export let asks: Record<string, string | null>
  export let hasBackend: boolean
  export let swipeEnabled: boolean
  export let openSwipeId: string | null
  export let handoffFor: string | null
  export let onSelect: (id: string | null | undefined) => void
  export let onReply: (id: string | undefined, reply: string) => void
  export let onSwipeOpen: (id: string) => void
  export let onSwipeClose: (id: string) => void
  export let onRestart: (s: Session) => void
  export let onCleanup: (s: Session) => void
  export let onToggleHandoff: (s: Session) => void
  export let onHandoff: (s: Session, kind: BackendKind) => void
</script>

<section>
  <div class="eyebrow hot">Needs you <span class="cnt">{needsSessions.length}</span></div>
  <div class="cards">
    {#each needsSessions as s (s.id ?? s.tid)}
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
        <button
          type="button"
          class="card"
          class:error={s.status === 'errored'}
          on:click={() => onSelect(s.id)}
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
          {#if findParentTitle(sessions, s.parentId)}
            <div class="spawned-by">↳ spawned by {findParentTitle(sessions, s.parentId)}</div>
          {/if}
          {#if s.status !== 'errored' && hasBackend && s.id && asks[s.id]}
            <div class="ask">{asks[s.id]}</div>
            {#if suggestedReplies(asks[s.id]).length > 0}
              <div class="reply-chips">
                {#each suggestedReplies(asks[s.id]) as reply (reply)}
                  <button
                    type="button"
                    class="chip reply-chip"
                    on:click|stopPropagation={() => onReply(s.id, reply)}
                  >
                    {reply}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
          <div class="c-foot">
            {#if s.branch}<span>{s.branch}</span>{/if}
            <span class="add">+{s.add}</span>
            <span class="del">−{s.del}</span>
            {#if countSpawned(sessions, s.id) > 0}
              <span class="chip mono">{countSpawned(sessions, s.id)} spawned</span>
            {/if}
            <span class="go" class:err={s.status === 'errored'}>Answer →</span>
          </div>
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

  /* needs-you cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
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
    width: 100%;
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
    font-size: 12px;
  }
  .c-top .dot {
    width: 7px;
    height: 7px;
    border-radius: 99px;
    flex: 0 0 auto;
    background: hsl(var(--st-needs));
    box-shadow: 0 0 0 0 hsl(var(--st-needs));
    animation: pulse 1.9s infinite;
  }
  .c-top .dot.err {
    background: hsl(var(--st-error));
    box-shadow: none;
    animation: none;
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
    font-size: 11px;
    color: hsl(var(--muted-foreground));
  }
  .c-title {
    font-size: 14px;
    font-weight: 600;
  }
  /* TASK-CIOEQ: additive "spawned by" annotation — a session started via
   * `slipstream new-agent` from another agent's run. */
  .spawned-by {
    font-size: 11px;
    color: hsl(var(--muted-foreground));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ask {
    font-family: 'JetBrains Mono', monospace;
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
  /* one-tap suggested replies (see suggestedReplies) */
  .reply-chips {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .reply-chip {
    border: 1px solid hsl(var(--st-needs) / 0.4);
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
    transition:
      background 0.12s ease,
      border-color 0.12s ease;
  }
  .reply-chip:hover {
    background: hsl(var(--st-needs) / 0.15);
    border-color: hsl(var(--st-needs) / 0.7);
  }
  .reply-chip:active {
    background: hsl(var(--st-needs) / 0.25);
  }
  .c-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
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
    font-family: 'Hanken Grotesk', sans-serif;
    font-size: 12px;
    font-weight: 550;
  }
  .c-foot .go.err {
    color: hsl(var(--st-error));
  }
  .chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 99px;
    background: hsl(var(--muted) / 0.6);
    color: hsl(var(--muted-foreground));
    flex: 0 0 auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .c-top .dot {
      animation: none;
    }
  }
</style>
