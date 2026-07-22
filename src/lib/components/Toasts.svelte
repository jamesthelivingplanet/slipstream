<script lang="ts">
  import { toasts, dismissToast, pauseToast, resumeToast } from '../toast'
</script>

<div class="toasts-wrap">
  {#each $toasts as t (t.id)}
    <div
      class="toast {t.type}"
      on:mouseenter={() => pauseToast(t.id)}
      on:mouseleave={() => resumeToast(t.id)}
    >
      <!-- Each toast is its own live region (FLO-115): role="alert" is
           assertive (errors), role="status" is polite (success/warning). The
           × button is a sibling, not inside the region, so screen readers
           announce only the message — never "Dismiss". -->
      <span
        class="toast-msg"
        role={t.type === 'error' ? 'alert' : 'status'}
        aria-live={t.type === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true">{t.message}</span>
      <button
        type="button"
        class="toast-close"
        aria-label="Dismiss notification"
        on:click|stopPropagation={() => dismissToast(t.id)}>×</button>
    </div>
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
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 420px;
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    border: 1px solid transparent;
    border-left-width: 3px;
    animation: slideIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .toast-msg {
    flex: 1 1 auto;
    /* Long/multi-clause errors (e.g. the stash-conflict warning) must be
       selectable and copyable, and must wrap without clipping. */
    user-select: text;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: default;
  }

  .toast-close {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    margin-top: -1px;
    padding: 0;
    line-height: 1;
    font-size: 16px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: hsl(var(--foreground) / 0.6);
    cursor: pointer;
  }

  .toast-close:hover {
    color: hsl(var(--foreground));
    background: hsl(var(--foreground) / 0.1);
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
