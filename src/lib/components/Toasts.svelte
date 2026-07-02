<script lang="ts">
  import { toasts, dismissToast } from '../toast'
</script>

<div class="toasts-wrap">
  {#each $toasts as t (t.id)}
    <button type="button" class="toast {t.type}" on:click={() => dismissToast(t.id)}>
      {t.message}
    </button>
  {/each}
</div>

<style>
  .toasts-wrap {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    max-width: 340px;
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    border: 1px solid transparent;
    border-left-width: 3px;
    animation: slideIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .toast.success {
    background: hsl(var(--st-done) / 0.1);
    border-color: hsl(var(--st-done) / 0.35);
    border-left-color: hsl(var(--st-done));
    color: hsl(var(--foreground));
  }

  .toast.error {
    background: hsl(var(--st-error) / 0.1);
    border-color: hsl(var(--st-error) / 0.35);
    border-left-color: hsl(var(--st-error));
    color: hsl(var(--foreground));
  }

  .toast.warning {
    background: hsl(var(--st-needs) / 0.1);
    border-color: hsl(var(--st-needs) / 0.35);
    border-left-color: hsl(var(--st-needs));
    color: hsl(var(--foreground));
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
</style>
