<script lang="ts">
  /**
   * TerminalView's header — the title/badges row (always visible) plus the
   * desktop-only action toolbar (ticket status, diff/chat toggle, run app,
   * remote control, hand-off, update-from-base, editor, cleanup, attach
   * image). Extracted verbatim from TerminalView.svelte's `.term-head` block.
   *
   * Pure presentation: every handler here is either a parent-owned function
   * passed straight through as a prop (business logic — resync/term/xterm
   * lifecycle, resumedIds, restarting/handingOff/updatingBase flags — all
   * stay in TerminalView.svelte) or a local DOM ref (`fileInput`) that only
   * this component's own `<input type="file">` needs.
   */
  import { icons } from '../icons'
  import { floatingAnchor } from '../floating'
  import { prBadges as computePrBadges } from '../prBadges'
  import type { Session, WorkflowState, BackendKind, Repo } from '../types'
  import type { PrStatusDTO, WorktreeUpdateMode } from '../../../electron/shared/contract.js'

  export let session: Session
  export let dot: string
  export let r: Repo | undefined
  export let base: string
  export let viewers: number
  export let liveMode: boolean
  export let mobile: boolean
  export let prStatus: PrStatusDTO | null

  export let shouldShow: boolean
  export let statusLoading: boolean
  export let statusError: string | null
  export let current: WorkflowState | null
  export let available: WorkflowState[]
  export let menuOpen: boolean
  export let onTriggerClick: () => void
  export let onSelectState: (state: WorkflowState) => void

  export let showDiff: boolean
  export let pendingCommentCount: number
  export let onToggleDiff: () => void

  export let chatAvailable: boolean
  export let viewMode: 'terminal' | 'chat'
  export let onToggleViewMode: () => void

  export let appRunning: boolean
  export let appUrl: string | undefined
  export let hasBackend: boolean
  export let onRunApp: () => void
  export let onStopApp: () => void
  export let onRestartApp: () => void

  export let currentKind: BackendKind
  export let onRemoteControl: () => void

  export let handoffOpen: boolean
  export let handoffTargets: { kind: BackendKind; label: string }[]
  export let handingOff: boolean
  export let onToggleHandoffMenu: () => void
  export let onHandoff: (kind: BackendKind) => void

  export let updateBaseOpen: boolean
  export let updatingBase: boolean
  export let onToggleUpdateBase: () => void
  export let onUpdateFromBase: (mode: WorktreeUpdateMode) => void

  export let onOpenEditor: () => void
  export let onCleanup: () => void

  export let canWrite: boolean
  export let onFileChange: (e: Event) => void
  export let onDeselect: () => void

  let fileInput: HTMLInputElement
</script>

<div class="term-head">
  <button class="btn btn-ghost btn-icon btn-sm" title="Deselect" on:click={onDeselect}>
    {@html icons.chevronLeft}
  </button>
  <div class="th-title">
    <div class="t">
      <span class="stat-dot" style="background:{dot}"></span>
      <span class="tt">{session.tid} · {session.title}</span>
    </div>
    <div class="m">
      <span class="badge mono"
        >{@html icons.folder} {r ? `${r.org}/${r.name}` : session.repo || 'unknown repo'}</span
      >
      <span class="badge mono">{@html icons.gitBranch} {session.branch}</span>
      {#if session.behind > 0}
        <span
          class="badge mono badge-behind"
          title={`This worktree is ${session.behind} commit${session.behind === 1 ? '' : 's'} behind ${base}`}
        >
          ↓ {session.behind} behind {base}
        </span>
      {/if}
      {#if liveMode && viewers > 1}
        <span class="badge mono">{viewers} viewers</span>
      {/if}
      {#if session.prUrl}
        <a class="badge mono" href={session.prUrl} target="_blank" rel="noopener noreferrer">
          {@html icons.externalLink} View PR
        </a>
        {#each computePrBadges(prStatus) as b (b.text)}
          <span class="badge mono pr-badge-{b.cls}" title={prStatus?.error}>{b.text}</span>
        {/each}
      {/if}
    </div>
  </div>
  <div class="spacer"></div>
  {#if !mobile}
    {#if shouldShow}
      <div class="sel-head" id="ticketStatusSel">
        {#if statusLoading && !current && available.length === 0}
          <button class="btn btn-outline btn-sm status-trigger" type="button" disabled>
            <span class="muted">Loading…</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
        {:else if statusError}
          <button
            class="btn btn-outline btn-sm status-trigger"
            type="button"
            disabled
            title={statusError}
          >
            <span class="muted">Status unavailable</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
        {:else if available.length === 0}
          <button class="btn btn-outline btn-sm status-trigger" type="button" disabled>
            <span class="muted">{current?.name ?? 'No statuses'}</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
        {:else}
          <button
            class="btn btn-outline btn-sm status-trigger"
            type="button"
            on:click|stopPropagation={onTriggerClick}
          >
            <span>{current?.name ?? 'Set status'}</span>
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
      {@html icons.fileDiff} <span class="btn-label">Diff</span>
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
        <span class="btn-label">{viewMode === 'chat' ? 'Terminal' : 'Chat'}</span>
      </button>
    {/if}
    {#if appRunning}
      {#if appUrl}
        <a
          class="btn btn-outline btn-sm"
          title="Open the running app over Tailscale"
          href={appUrl}
          target="_blank"
          rel="noopener noreferrer"
          >{@html icons.externalLink} <span class="btn-label">Open app</span></a
        >
      {/if}
      <button
        class="btn btn-outline btn-sm"
        title="Stop the running app"
        disabled={!hasBackend || !session.id || !session.branch || !session.repo}
        on:click={onStopApp}>{@html icons.stop} <span class="btn-label">Stop</span></button
      >
      <button
        class="btn btn-outline btn-sm"
        title="Restart the running app"
        disabled={!hasBackend || !session.id || !session.branch || !session.repo}
        on:click={onRestartApp}>{@html icons.refresh} <span class="btn-label">Restart</span></button
      >
    {:else}
      <button
        class="btn btn-outline btn-sm"
        title="Run the app using this repository's start command"
        disabled={!hasBackend || !session.id || !session.branch || !session.repo}
        on:click={onRunApp}>{@html icons.play} <span class="btn-label">Run</span></button
      >
    {/if}
    {#if currentKind === 'claude-code'}
      <button
        class="btn btn-outline btn-sm"
        title="Relaunch this agent with Claude Code Remote Control"
        disabled={!hasBackend || !session.id}
        on:click={onRemoteControl}
        >{@html icons.remote} <span class="btn-label">Remote control</span></button
      >
    {/if}
    <div class="sel-head" id="handoffSel">
      <button
        class="btn btn-outline btn-sm"
        title="Continue this run with a different agent (e.g. when this one hit its limits)"
        disabled={!hasBackend || !session.id || session.status === 'queued' || handingOff}
        on:click|stopPropagation={onToggleHandoffMenu}
        >{@html icons.refresh}
        <span class="btn-label">{handingOff ? 'Handing off…' : 'Hand off'}</span></button
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
    {#if session.behind > 0}
      <div class="sel-head" id="updateBaseSel">
        <button
          class="btn btn-outline btn-sm"
          title={`Rebase ${session.branch} onto the latest ${base} (uncommitted changes are autostashed)`}
          disabled={!hasBackend || !session.repo || !session.branch || updatingBase}
          on:click={() => onUpdateFromBase('rebase')}
        >
          {@html icons.refresh}
          <span class="btn-label">{updatingBase ? 'Updating…' : `Update from ${base}`}</span>
        </button>
        <button
          class="btn btn-outline btn-sm btn-icon"
          title="Choose rebase or merge"
          disabled={!hasBackend || updatingBase}
          on:click|stopPropagation={onToggleUpdateBase}
        >
          {@html icons.chevronDown}
        </button>
        {#if updateBaseOpen}
          <div class="sel-menu" use:floatingAnchor>
            <button type="button" class="opt" on:click={() => onUpdateFromBase('rebase')}>
              <span>Rebase onto {base} (recommended)</span>
            </button>
            <button type="button" class="opt" on:click={() => onUpdateFromBase('merge')}>
              <span>Merge {base} into {session.branch}</span>
            </button>
          </div>
        {/if}
      </div>
    {/if}
    <button
      class="btn btn-outline btn-sm"
      title="Open the worktree in your configured editor"
      disabled={!hasBackend || !session.repo || !session.branch}
      on:click={onOpenEditor}
    >
      {@html icons.externalLink} <span class="btn-label">Editor</span>
    </button>
    <button class="btn btn-outline btn-sm btn-danger" on:click={onCleanup}>
      {@html icons.trash} <span class="btn-label">Clean up</span>
    </button>
    <!-- Attach image button (TASK-6R28O) -->
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      style="display:none"
      on:change={onFileChange}
    />
    <button
      type="button"
      class="btn btn-outline btn-sm btn-icon"
      title="Attach image"
      aria-label="Attach image"
      disabled={!canWrite || !session.id}
      on:click={() => fileInput.click()}
    >
      {@html icons.image}
    </button>
  {/if}
</div>

<style>
  /* PR/CI status badges (FLO-96) */
  .pr-badge-done {
    color: hsl(var(--st-done));
    border-color: hsl(var(--st-done) / 0.4);
  }
  .pr-badge-error {
    color: hsl(var(--st-error));
    border-color: hsl(var(--st-error) / 0.4);
  }
  .pr-badge-needs {
    color: hsl(var(--st-needs));
    border-color: hsl(var(--st-needs) / 0.4);
  }
  .badge-behind {
    color: hsl(var(--st-needs));
    border-color: hsl(var(--st-needs) / 0.4);
  }

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
