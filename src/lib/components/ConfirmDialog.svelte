<script lang="ts">
  import { confirmState, mobile } from '../stores'
  import ResponsivePanel from './ResponsivePanel.svelte'

  function finish(ok: boolean) {
    const req = $confirmState
    confirmState.set(null)
    req?.resolve(ok)
  }

  function onKeydown(e: KeyboardEvent) {
    if ($confirmState && e.key === 'Escape') finish(false)
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $confirmState}
  <ResponsivePanel open mobile={$mobile} onClose={() => finish(false)}>
    <svelte:fragment slot="header">
      <h2>{$confirmState.title}</h2>
      <p>{$confirmState.message}</p>
    </svelte:fragment>

    <div class="dlg-body">
      {#if $confirmState.detail}
        <pre class="confirm-detail">{$confirmState.detail}</pre>
      {/if}
    </div>

    <svelte:fragment slot="footer">
      <button class="btn btn-ghost" on:click={() => finish(false)}>
        {$confirmState.cancelLabel ?? 'Cancel'}
      </button>
      <button
        class="btn {$confirmState.danger ? 'btn-danger' : 'btn-primary'}"
        on:click={() => finish(true)}
      >
        {$confirmState.confirmLabel ?? 'Confirm'}
      </button>
    </svelte:fragment>
  </ResponsivePanel>
{/if}

<style>
  .confirm-detail {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid hsl(var(--border));
    background: hsl(var(--muted) / 0.4);
    color: hsl(var(--foreground));
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
