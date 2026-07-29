<script lang="ts">
  import { onMount } from 'svelte'

  /** Shown after a failed/canceled unlock attempt. */
  export let error: string = ''
  /** Triggers the native biometric prompt. Resolves once the attempt settles
   *  (success or failure) — this component itself doesn't decide what
   *  happens next, the caller (main.ts / App.svelte) does. */
  export let onUnlock: () => void | Promise<void>
  export let onSignOut: () => void | Promise<void>

  let busy = false

  async function handleUnlock() {
    if (busy) return
    busy = true
    try {
      await onUnlock()
    } finally {
      busy = false
    }
  }

  function handleSignOut() {
    if (busy) return
    onSignOut()
  }

  // Auto-trigger once on mount so the system prompt appears immediately on
  // app open / resume — but never auto-retry after a failure (a canceled or
  // failed attempt is a deliberate user signal, not something to keep
  // hammering them with); the "Unlock" button is there for the retry.
  onMount(() => {
    handleUnlock()
  })
</script>

<div class="gate-bg">
  <div class="gate-card">
    <div class="gate-logo">
      <img src="/icons/nulliel-glyph.svg" alt="Slipstream" class="glyph" />
      <b>Slipstream</b>
    </div>
    <h2>Unlock Slipstream</h2>
    <p class="gate-hint">
      Your saved server token is protected by your fingerprint. Confirm to continue.
    </p>

    {#if error}
      <div class="gate-error">{error}</div>
    {/if}

    <button class="btn btn-primary gate-btn" on:click={handleUnlock} disabled={busy}>
      {busy ? 'Waiting…' : 'Unlock'}
    </button>
    <button type="button" class="gate-signout" on:click={handleSignOut} disabled={busy}>
      Sign out
    </button>
  </div>
</div>

<style>
  .gate-bg {
    position: fixed;
    inset: 0;
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    background: hsl(var(--background));
  }

  .gate-card {
    width: 340px;
    max-width: 90vw;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) + 2px);
    box-shadow: var(--shadow);
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .gate-logo {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 4px;
  }

  .gate-logo .glyph {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    object-fit: contain;
  }

  .gate-logo b {
    font-weight: 600;
    font-size: 14px;
  }

  h2 {
    font-size: 17px;
    font-weight: 600;
    color: hsl(var(--foreground));
    margin: 0;
  }

  .gate-hint {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    line-height: 1.5;
    margin: 0;
  }

  .gate-error {
    font-size: 13px;
    color: hsl(var(--st-error));
    background: hsl(var(--st-error) / 0.1);
    border: 1px solid hsl(var(--st-error) / 0.3);
    border-radius: var(--radius);
    padding: 8px 12px;
  }

  .gate-btn {
    width: 100%;
    height: 38px;
  }

  .gate-signout {
    align-self: center;
    background: none;
    border: none;
    padding: 4px;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
  }

  .gate-signout:hover {
    color: hsl(var(--foreground));
    text-decoration: underline;
  }

  .gate-signout:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
