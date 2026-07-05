<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { mobile } from '../stores'
  import { AGENTS } from '../agents'
  import { icons } from '../icons'
  import type { BackendKind } from '../types'

  export let value: BackendKind
  export let label: string = 'Agent'

  const dispatch = createEventDispatcher<{ select: BackendKind }>()

  function choose(kind: BackendKind) {
    if (kind !== value) dispatch('select', kind)
  }

  function onSelectChange(e: Event) {
    choose((e.currentTarget as HTMLSelectElement).value as BackendKind)
  }
</script>

{#if $mobile}
  <div class="select agent-select">
    <select aria-label={label} {value} on:change={onSelectChange}>
      {#each AGENTS as a (a.kind)}
        <option value={a.kind}>{a.label}</option>
      {/each}
    </select>
    <span class="chev">{@html icons.chevronDown}</span>
  </div>
{:else}
  <div class="agent-grid" role="radiogroup" aria-label={label}>
    {#each AGENTS as a (a.kind)}
      <button
        type="button"
        class="agent-card"
        class:active={value === a.kind}
        role="radio"
        aria-checked={value === a.kind}
        on:click={() => choose(a.kind)}
      >
        <img class="agent-card-icon" src={a.icon} alt="" width="28" height="28" />
        <span class="agent-card-label">{a.label}</span>
        {#if value === a.kind}<span class="agent-card-check">{@html icons.check}</span>{/if}
      </button>
    {/each}
  </div>
{/if}
