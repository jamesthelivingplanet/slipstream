<script lang="ts">
  import { onMount } from 'svelte'

  /** Shown in web mode when no token is stored/provided. */
  export let error: string = ''
  export let onSubmit: (token: string) => void

  let value = ''
  let inputEl: HTMLInputElement

  onMount(() => {
    inputEl?.focus()
  })

  function submit() {
    const t = value.trim()
    if (t) onSubmit(t)
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') submit()
  }
</script>

<div class="gate-bg">
  <div class="gate-card">
    <div class="gate-logo">
      <img src="/icons/icon.svg" alt="Slipstream" class="glyph" />
      <b>Slipstream</b>
    </div>
    <h2>Access token required</h2>
    <p class="gate-hint">Enter the token configured on the Slipstream server.</p>

    {#if error}
      <div class="gate-error">{error}</div>
    {/if}

    <input
      type="password"
      class="gate-input"
      placeholder="Token"
      bind:value
      bind:this={inputEl}
      on:keydown={keydown}
    />

    <button class="btn btn-primary gate-btn" on:click={submit} disabled={!value.trim()}>
      Connect
    </button>
  </div>
</div>

<style>
  .gate-bg {
    position: fixed;
    inset: 0;
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
    font-size: 14.5px;
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
    font-size: 12.5px;
    color: hsl(var(--st-error));
    background: hsl(var(--st-error) / 0.1);
    border: 1px solid hsl(var(--st-error) / 0.3);
    border-radius: var(--radius);
    padding: 8px 12px;
  }

  .gate-input {
    width: 100%;
    height: 38px;
    background: hsl(var(--background));
    border: 1px solid hsl(var(--input));
    border-radius: var(--radius);
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    padding: 0 12px;
  }

  .gate-input:focus {
    outline: none;
    border-color: hsl(var(--ring));
    box-shadow: 0 0 0 3px hsl(var(--ring) / 0.12);
  }

  .gate-btn {
    width: 100%;
    height: 38px;
  }
</style>
