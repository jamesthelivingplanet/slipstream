<script lang="ts">
  import { icons } from '../../icons'

  export let title: string
  export let open = false

  function toggle() {
    open = !open
  }
</script>

<div class="section">
  <button type="button" class="section-header" aria-expanded={open} on:click={toggle}>
    <span class="section-title">{title}</span>
    <span class="section-chevron" class:open>{@html icons.chevronDown}</span>
  </button>
  {#if open}
    <div class="section-body">
      <slot />
    </div>
  {/if}
</div>

<style>
  .section {
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    background: hsl(var(--card));
    overflow: hidden;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: hsl(var(--foreground));
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    transition: background 0.12s;
  }

  .section-header:hover {
    background: hsl(var(--card-hover));
  }

  .section-chevron {
    display: inline-flex;
    color: hsl(var(--muted-foreground));
    transition: transform 0.15s;
    transform: rotate(-90deg);
  }

  .section-chevron.open {
    transform: rotate(0deg);
  }

  .section-body {
    padding: 4px 12px 12px;
    border-top: 1px solid hsl(var(--border));
    display: flex;
    flex-direction: column;
  }
</style>
