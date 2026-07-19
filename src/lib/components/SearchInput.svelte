<script lang="ts">
  import { icons } from '../icons'

  export let placeholder = 'Search…'
  export let value = ''
  export let onInput: (value: string) => void = () => {}
  export let loading = false
  export let showClear = false
  export let ariaLabel: string | undefined = undefined

  function handleInput(e: Event) {
    const v = (e.target as HTMLInputElement).value
    value = v
    onInput(v)
  }

  function clear() {
    value = ''
    onInput('')
  }
</script>

<div class="search-input-wrap">
  <input
    type="search"
    class="path-input"
    placeholder={placeholder}
    bind:value={value}
    on:input={handleInput}
    aria-label={ariaLabel ?? placeholder}
  />
  {#if showClear && value}
    <button
      class="search-clear"
      type="button"
      on:click={clear}
      aria-label="Clear search"
    >
      {@html icons.trash}
    </button>
  {/if}
  {#if loading}
    <span class="search-spinner" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="1s"
            repeatCount="indefinite"
          />
        </path>
      </svg>
    </span>
  {/if}
</div>

<style>
  .search-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-input-wrap .path-input {
    flex: 1;
    min-width: 0;
  }
  .search-clear {
    position: absolute;
    right: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
    border-radius: var(--radius);
  }
  .search-clear:hover {
    background: hsl(var(--accent-bg));
    color: hsl(var(--foreground));
  }
  .search-spinner {
    position: absolute;
    right: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: hsl(var(--primary));
  }
</style>