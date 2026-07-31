<script lang="ts">
  /**
   * TerminalView's mobile action bar (`.term-actions`, rendered only when
   * `$mobile`) — ticket status, diff toggle, chat toggle, hand-off, cleanup,
   * and the "more" overflow menu (run/stop/restart app, remote control,
   * editor, update-from-base). Extracted verbatim from TerminalView.svelte.
   *
   * Pure presentation: every action here is a parent-owned handler passed
   * through as a prop — the `moreOpen`-closing wrapper functions
   * (moreOpenApp/moreStopApp/... in TerminalView.svelte) already fold the
   * "close the menu, then act" sequencing in, so this component only wires
   * clicks to whatever callback it was given.
   */
  import { icons } from '../icons'
  import { floatingAnchor } from '../floating'
  import type { Session, WorkflowState, BackendKind } from '../types'

  export let shouldShow: boolean
  export let statusError: string | null
  export let available: WorkflowState[]
  export let current: WorkflowState | null
  export let menuOpen: boolean
  export let dot: string
  export let onTriggerClick: () => void
  export let onSelectState: (state: WorkflowState) => void

  export let showDiff: boolean
  export let pendingCommentCount: number
  export let onToggleDiff: () => void

  export let chatAvailable: boolean
  export let viewMode: 'terminal' | 'chat'
  export let onToggleViewMode: () => void

  export let hasBackend: boolean
  export let session: Session

  export let handoffOpen: boolean
  export let handoffTargets: { kind: BackendKind; label: string }[]
  export let handingOff: boolean
  export let onToggleHandoffMenu: () => void
  export let onHandoff: (kind: BackendKind) => void

  export let onCleanup: () => void

  export let moreOpen: boolean
  export let onToggleMore: () => void
  export let appRunning: boolean
  export let appUrl: string | undefined
  export let onOpenApp: () => void
  export let onStopApp: () => void
  export let onRestartApp: () => void
  export let onRunApp: () => void
  export let currentKind: BackendKind
  export let onRemoteControl: () => void
  export let onOpenEditor: () => void
  export let base: string
  export let updatingBase: boolean
  export let onUpdateFromBaseRebase: () => void
  export let onUpdateFromBaseMerge: () => void
</script>

<div class="term-actions">
  {#if shouldShow}
    <div class="sel-head" id="ticketStatusSelMob">
      <button
        class="btn btn-outline btn-sm status-trigger"
        type="button"
        disabled={!!statusError || available.length === 0}
        title={statusError ?? current?.name ?? 'Set status'}
        on:click|stopPropagation={onTriggerClick}
      >
        <span class="stat-dot" style="background:{dot}"></span>
        <span class="chev">{@html icons.chevronDown}</span>
      </button>
      {#if menuOpen}
        <div class="sel-menu" use:floatingAnchor>
          {#each available as state (state.id)}
            <button
              type="button"
              class="opt"
              class:sel={current?.id === state.id}
              on:click={() => onSelectState(state)}
            >
              <span>{state.name}</span>
              <span class="check">{@html icons.check}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <button
    class="btn btn-outline btn-sm"
    class:btn-active={showDiff}
    title="Review the worktree diff and comment on lines"
    disabled={!session.repo || !session.branch}
    on:click={onToggleDiff}
  >
    {@html icons.fileDiff}
    {#if pendingCommentCount > 0}
      <span class="diff-count">{pendingCommentCount}</span>
    {/if}
  </button>
  {#if chatAvailable}
    <button
      class="btn btn-outline btn-sm"
      class:btn-active={viewMode === 'chat'}
      title={viewMode === 'chat' ? 'Switch to the terminal' : 'Switch to chat'}
      on:click={onToggleViewMode}
    >
      {@html viewMode === 'chat' ? icons.terminal : icons.chat}
    </button>
  {/if}
  <div class="sel-head" id="handoffSelMob">
    <button
      class="btn btn-outline btn-sm"
      title="Continue this run with a different agent"
      disabled={!hasBackend || !session.id || session.status === 'queued' || handingOff}
      on:click|stopPropagation={onToggleHandoffMenu}>{@html icons.refresh}</button
    >
    {#if handoffOpen}
      <div class="sel-menu" use:floatingAnchor>
        {#each handoffTargets as agent (agent.kind)}
          <button type="button" class="opt" on:click={() => onHandoff(agent.kind)}>
            <span>Continue with {agent.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <button class="btn btn-outline btn-sm btn-danger" title="Clean up" on:click={onCleanup}>
    {@html icons.trash}
  </button>
  <div class="sel-head" id="moreSelMob">
    <button
      class="btn btn-outline btn-sm"
      type="button"
      title="More actions"
      on:click|stopPropagation={onToggleMore}>{@html icons.more}</button
    >
    {#if moreOpen}
      <div class="sel-menu" use:floatingAnchor>
        {#if appRunning}
          {#if appUrl}
            <button type="button" class="opt" on:click={onOpenApp}>
              <span>{@html icons.externalLink} Open app</span>
            </button>
          {/if}
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.id || !session.branch || !session.repo}
            on:click={onStopApp}
          >
            <span>{@html icons.stop} Stop</span>
          </button>
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.id || !session.branch || !session.repo}
            on:click={onRestartApp}
          >
            <span>{@html icons.refresh} Restart</span>
          </button>
        {:else}
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.id || !session.branch || !session.repo}
            on:click={onRunApp}
          >
            <span>{@html icons.play} Run</span>
          </button>
        {/if}
        {#if currentKind === 'claude-code'}
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.id}
            on:click={onRemoteControl}
          >
            <span>{@html icons.remote} Remote control</span>
          </button>
        {/if}
        <button
          type="button"
          class="opt"
          disabled={!hasBackend || !session.repo || !session.branch}
          on:click={onOpenEditor}
        >
          <span>{@html icons.externalLink} Editor</span>
        </button>
        {#if session.behind > 0}
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.repo || !session.branch || updatingBase}
            on:click={onUpdateFromBaseRebase}
          >
            <span>{@html icons.refresh} Update from {base} (rebase)</span>
          </button>
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.repo || !session.branch || updatingBase}
            on:click={onUpdateFromBaseMerge}
          >
            <span>{@html icons.refresh} Merge {base} into branch</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .btn-active {
    background: hsl(var(--primary) / 0.12);
    border-color: hsl(var(--primary) / 0.5);
    color: hsl(var(--primary));
  }

  .diff-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
  }

  .status-trigger {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    min-width: 100px;
    gap: 4px;
  }
  .status-trigger .chev {
    color: hsl(var(--muted-foreground));
    display: flex;
  }
  @media (max-width: 700px) {
    /* Let app.css's .term-actions square-chip sizing win — the scoped
       min-width above would otherwise outrank it in the cascade. */
    .term-actions .status-trigger {
      min-width: 0;
    }
  }
  .sel-head {
    position: relative;
  }
  .sel-menu {
    position: absolute;
    top: 38px;
    left: 0;
    z-index: 60;
    padding: 5px;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    max-height: 260px;
    overflow-y: auto;
    animation: pop 0.14s ease;
    min-width: 160px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: calc(var(--radius) - 3px);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    width: 100%;
  }
  .opt:hover {
    background: hsl(var(--accent-bg));
  }
  .opt .check {
    margin-left: auto;
    color: hsl(var(--primary));
    opacity: 0;
  }
  .opt.sel .check {
    opacity: 1;
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
