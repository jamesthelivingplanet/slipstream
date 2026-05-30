<script lang="ts">
  import { mode, accent, ACCENTS } from '../theme'
  import { icons } from '../icons'

  let open = false

  function onWindowClick(e: MouseEvent) {
    if (open && !(e.target as HTMLElement).closest('.pop-wrap')) open = false
  }
</script>

<svelte:window on:click={onWindowClick} />

<div class="pop-wrap">
  <button class="btn btn-outline btn-icon btn-sm" title="Theme" on:click|stopPropagation={() => (open = !open)}>
    {@html icons.palette}
  </button>

  {#if open}
    <div class="pop">
      <div class="lbl">Mode</div>
      <div class="mode-toggle">
        <button type="button" class="mt" class:on={$mode === 'light'} on:click={() => mode.set('light')}>
          {@html icons.sun}Light
        </button>
        <button type="button" class="mt" class:on={$mode === 'dark'} on:click={() => mode.set('dark')}>
          {@html icons.moon}Dark
        </button>
      </div>
      <div class="lbl">Accent</div>
      <div class="swatches">
        {#each Object.entries(ACCENTS) as [key, col]}
          <button
            type="button"
            class="sw"
            class:on={$accent === key}
            style="background:{col}"
            title={key}
            on:click={() => accent.set(key)}
            aria-label={key}
          ></button>
        {/each}
      </div>
    </div>
  {/if}
</div>
