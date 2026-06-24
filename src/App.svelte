<script lang="ts">
  import { onMount } from 'svelte'
  import TicketStatusBar from './lib/components/TicketStatusBar.svelte'
  import { selected, dialogOpen, settingsOpen, initFromBackend, refreshAndReconcile, select } from './lib/stores'
  import { icons } from './lib/icons'
  import AgentList from './lib/components/AgentList.svelte'
  import AgentConfig from './lib/components/AgentConfig.svelte'
  import TerminalView from './lib/components/TerminalView.svelte'
  import NewAgentDialog from './lib/components/NewAgentDialog.svelte'
  import SettingsModal from './lib/components/SettingsModal.svelte'
  import Toasts from './lib/components/Toasts.svelte'
  import ThemeMenu from './lib/components/ThemeMenu.svelte'
  import { MOBILE_MEDIA_QUERY } from './lib/responsive'

  // Mobile drawer state — the sidebar is an overlay on narrow viewports.
  let listOpen = false
  let isMobile = false

  function checkMobile() {
    isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches
  }

  onMount(() => {
    initFromBackend().then(() => {
      return refreshAndReconcile().then(() => {
        // Deep-link: open agent specified in ?agent= query param (set by SW notificationclick)
        const params = new URLSearchParams(location.search)
        const agentTid = params.get('agent')
        if (agentTid) {
          select(agentTid)
          params.delete('agent')
          const clean = params.toString()
          history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : '') + location.hash)
        }
      })
    })

    // SW message: focus agent when notification is clicked in an already-open window
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
        if (e.data?.type === 'open-agent' && e.data.tid) {
          select(e.data.tid as string)
        }
      })
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    window.addEventListener('orientationchange', checkMobile)
    return () => {
      window.removeEventListener('resize', checkMobile)
      window.removeEventListener('orientationchange', checkMobile)
    }
  })

  // When an agent is selected on mobile, close the drawer.
  $: if ($selected && isMobile) listOpen = false
</script>

<div class="app">
  <header class="bar">
    {#if isMobile}
      <!-- Hamburger: toggles the agent list drawer on mobile -->
      <button
        class="btn btn-ghost btn-icon btn-sm"
        title="Agent list"
        on:click={() => (listOpen = !listOpen)}
        aria-label="Toggle agent list"
      >
        {@html icons.terminal}
      </button>
    {/if}
    <div class="logo">
      <img src="/icons/icon.svg" alt="Slipstream" class="glyph" />
      <b>Slipstream</b>
      {#if !isMobile}<span class="badge mono">dangerous mode</span>{/if}
    </div>
    <div class="spacer"></div>
    <ThemeMenu />
    <button class="btn btn-outline btn-icon btn-sm" title="Refresh tickets" on:click={refreshAndReconcile}>
      {@html icons.refresh}
    </button>
    <button class="btn btn-outline btn-icon btn-sm" title="Settings" on:click={() => settingsOpen.set(true)}>
      {@html icons.settings}
    </button>
    <button class="btn btn-primary btn-sm" on:click={() => dialogOpen.set(true)}>
      {@html icons.plus} {isMobile ? '' : 'New agent'}
    </button>
  </header>

  <!-- Mobile overlay backdrop: tap outside drawer to close -->
  {#if isMobile && listOpen}
    <div
      class="drawer-backdrop"
      on:click={() => (listOpen = false)}
      role="presentation"
    ></div>
  {/if}

  <div class="content">
    <AgentList mobileOpen={!isMobile || listOpen} />

    <section class="term-pane">
      {#if !$selected}
        <div class="empty">
          <div>
            <div class="ic">{@html icons.terminal}</div>
            <h3>No agent selected</h3>
            <p>Pick an agent on the left to view its terminal, or start a new one.</p>
          </div>
        </div>
      {:else}
        <TicketStatusBar session={$selected} />
        {#if $selected.status === 'idle'}
          <AgentConfig session={$selected} />
        {:else}
          {#key $selected.tid}
            <TerminalView session={$selected} />
          {/key}
        {/if}
      {/if}
    </section>
  </div>

  <NewAgentDialog />
  <SettingsModal />
  <Toasts />
</div>

<style>
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 29;
    background: rgba(0, 0, 0, 0.45);
  }
</style>
