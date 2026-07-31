<script lang="ts">
  /**
   * TerminalView's stacked status alert bars — view-only, needs-input,
   * agent-exited, and buffered-input-while-disconnected. Extracted verbatim
   * from TerminalView.svelte; purely presentational, all state (canWrite,
   * needsInput, exited, pendingInputBytes, ...) and handlers (take-over,
   * restart, hand-off) stay owned by the parent and are passed through as
   * props.
   */
  import { icons } from '../icons'
  import type { BackendKind } from '../types'

  export let liveMode: boolean
  export let canWrite: boolean
  export let onTakeOver: () => void

  export let needsInput: boolean
  export let alertMsg: string

  export let exited: boolean
  export let exitCode: number | null
  export let restarting: boolean
  export let handingOff: boolean
  export let handoffTargets: { kind: BackendKind; label: string }[]
  export let onRestart: () => void
  export let onHandoff: (kind: BackendKind) => void

  export let connected: boolean
  export let pendingInputBytes: number
</script>

{#if liveMode && !canWrite}
  <div class="alert">
    <span class="ic">{@html icons.remote}</span>
    <div class="tx"><b>View-only</b><span>Another client is controlling this session.</span></div>
    <button class="btn btn-sm" on:click={onTakeOver}>Take over</button>
  </div>
{/if}

{#if needsInput}
  <div class="alert">
    <span class="ic">{@html icons.alert}</span>
    <div class="tx"><b>Agent needs your input</b><span>{alertMsg}</span></div>
    <div class="keys">
      <span class="kbd">1</span><span class="kbd">2</span><span class="kbd">↵</span>
    </div>
  </div>
{/if}

{#if liveMode && exited}
  <div class="alert">
    <span class="ic">{@html icons.refresh}</span>
    <div class="tx">
      <b>Agent closed out</b>
      <span>
        {exitCode === 0
          ? 'The agent process exited.'
          : `The agent process exited with code ${exitCode}.`}
        Restart it to keep working in the same worktree, or hand the run off to a different agent.
      </span>
    </div>
    <button class="btn btn-sm" disabled={restarting} on:click={onRestart}>
      {restarting ? 'Restarting…' : 'Restart'}
    </button>
    {#each handoffTargets as agent (agent.kind)}
      <button class="btn btn-sm" disabled={handingOff} on:click={() => onHandoff(agent.kind)}>
        Continue with {agent.label}
      </button>
    {/each}
  </div>
{/if}

{#if liveMode && !connected && pendingInputBytes > 0}
  <!-- FLO-154: typed input is buffered client-side while the transport is down
       and flushed on reconnect — show that it's held, not silently lost. -->
  <div class="alert" role="status">
    <span class="ic">{@html icons.uploadCloud}</span>
    <div class="tx">
      <b>Will send once reconnected</b>
      <span>{pendingInputBytes} character{pendingInputBytes === 1 ? '' : 's'} queued.</span>
    </div>
  </div>
{/if}
