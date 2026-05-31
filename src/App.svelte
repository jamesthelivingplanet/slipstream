<script lang="ts">
  import { onMount } from 'svelte'
  import { selected, dialogOpen, settingsOpen, initFromBackend } from './lib/stores'
  import { icons } from './lib/icons'
  import AgentList from './lib/components/AgentList.svelte'
  import AgentConfig from './lib/components/AgentConfig.svelte'
  import TerminalView from './lib/components/TerminalView.svelte'
  import NewAgentDialog from './lib/components/NewAgentDialog.svelte'
  import SettingsModal from './lib/components/SettingsModal.svelte'
  import Toasts from './lib/components/Toasts.svelte'
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
    <button class="btn btn-outline btn-icon btn-sm" title="Settings" on:click={() => settingsOpen.set(true)}>
      {@html icons.settings}
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
  <SettingsModal />
  <Toasts />
</div>
