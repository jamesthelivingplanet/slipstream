<script lang="ts">
  import { onMount } from 'svelte'
  import { selected, dialogOpen, initFromBackend, registerRepo } from './lib/stores'
  import { icons } from './lib/icons'
  import AgentList from './lib/components/AgentList.svelte'
  import AgentConfig from './lib/components/AgentConfig.svelte'
  import TerminalView from './lib/components/TerminalView.svelte'
  import NewAgentDialog from './lib/components/NewAgentDialog.svelte'
  import ThemeMenu from './lib/components/ThemeMenu.svelte'

  onMount(() => {
    initFromBackend()
  })
</script>

<div class="app">
  <header class="bar">
    <div class="logo">
      <div class="glyph">F</div>
      <b>Flotilla</b>
      <span class="badge mono">dangerous mode</span>
    </div>
    <div class="spacer"></div>
    <ThemeMenu />
    <button class="btn btn-outline btn-sm" on:click={() => registerRepo()}>
      {@html icons.plus} Add repo
    </button>
    <button class="btn btn-primary btn-sm" on:click={() => dialogOpen.set(true)}>
      {@html icons.plus} New agent
    </button>
  </header>

  <div class="content">
    <AgentList />

    <section class="term-pane">
      {#if !$selected}
        <div class="empty">
          <div>
            <div class="ic">{@html icons.terminal}</div>
            <h3>No agent selected</h3>
            <p>Pick an agent on the left to view its terminal, or start a new one.</p>
          </div>
        </div>
      {:else if $selected.status === 'idle'}
        <AgentConfig session={$selected} />
      {:else}
        {#key $selected.tid}
          <TerminalView session={$selected} />
        {/key}
      {/if}
    </section>
  </div>

  <NewAgentDialog />
</div>
