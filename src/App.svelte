<script lang="ts">
  import { onMount } from 'svelte'
  import TicketStatusBar from './lib/components/TicketStatusBar.svelte'
  import {
    selected,
    dialogOpen,
    settingsOpen,
    initFromBackend,
    refreshAndReconcile,
    select,
    subscribeSessionStatus,
    subscribeSessionPr,
    mobile,
    contentLoading,
    contentResolvedAt,
    contentRefreshNonce,
  } from './lib/stores'
  import { icons } from './lib/icons'
  import AgentList from './lib/components/AgentList.svelte'
  import AgentConfig from './lib/components/AgentConfig.svelte'
  import MissionControl from './lib/components/MissionControl.svelte'
  import TerminalView from './lib/components/TerminalView.svelte'
  import NewAgentDialog from './lib/components/NewAgentDialog.svelte'
  import SettingsModal from './lib/components/SettingsModal.svelte'
  import Toasts from './lib/components/Toasts.svelte'
  import ConfirmDialog from './lib/components/ConfirmDialog.svelte'
  import InstallNudge from './lib/components/InstallNudge.svelte'
  import ThemeMenu from './lib/components/ThemeMenu.svelte'
  import McpStatus from './lib/components/McpStatus.svelte'
  import { MOBILE_MEDIA_QUERY } from './lib/responsive'

  // Mobile drawer state — the sidebar is an overlay on narrow viewports.
  let listOpen = false

  let showCheck = false
  let checkTimer: ReturnType<typeof setTimeout> | undefined
  // FLO-56: show a brief check mark on the refresh button after agent content resolves.
  // Kept as a plain function (not inlined in the $: block) so checkTimer isn't read
  // inside the reactive statement itself — Svelte would otherwise treat it as a
  // dependency of the statement it's also assigned in.
  function flashCheck() {
    showCheck = true
    clearTimeout(checkTimer)
    checkTimer = setTimeout(() => (showCheck = false), 1500)
  }
  $: if ($contentResolvedAt) flashCheck()

  function onRefresh() {
    // Keep existing refresh behavior AND fetch the selected agent's content.
    refreshAndReconcile()
    contentRefreshNonce.update((n) => n + 1)
  }

  function checkMobile() {
    mobile.set(window.matchMedia(MOBILE_MEDIA_QUERY).matches)
  }

  onMount(() => {
    const offStatus = subscribeSessionStatus()
    const offPr = subscribeSessionPr()

    initFromBackend().then(() => {
      return refreshAndReconcile().then(() => {
        // Deep-link: open agent specified in ?agent= query param (set by SW notificationclick)
        const params = new URLSearchParams(location.search)
        const agentId = params.get('agent')
        if (agentId) {
          select(agentId)
          params.delete('agent')
          const clean = params.toString()
          history.replaceState(
            null,
            '',
            location.pathname + (clean ? `?${clean}` : '') + location.hash,
          )
        }
      })
    })

    // SW message: focus agent when notification is clicked in an already-open window
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
        if (e.data?.type === 'open-agent' && e.data.sessionId) {
          select(e.data.sessionId as string)
        }
      })
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    window.addEventListener('orientationchange', checkMobile)
    return () => {
      offStatus()
      offPr()
      window.removeEventListener('resize', checkMobile)
      window.removeEventListener('orientationchange', checkMobile)
    }
  })

  // When an agent is selected on mobile, close the drawer.
  $: if ($selected && $mobile) listOpen = false
</script>

<div class="app">
  <header class="bar">
    {#if $mobile}
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
      {#if !$mobile}<span class="badge mono">dangerous mode</span>{/if}
      <McpStatus />
    </div>
    <div class="spacer"></div>
    <ThemeMenu />
    <button class="btn btn-outline btn-icon btn-sm" title="Refresh" on:click={onRefresh}>
      {#if $contentLoading}
        <span class="spin">{@html icons.refresh}</span>
      {:else if showCheck}
        {@html icons.check}
      {:else}
        {@html icons.refresh}
      {/if}
    </button>
    <button
      class="btn btn-outline btn-icon btn-sm"
      title="Settings"
      on:click={() => settingsOpen.set(true)}
    >
      {@html icons.settings}
    </button>
    <button class="btn btn-primary btn-sm" on:click={() => dialogOpen.set(true)}>
      {@html icons.plus}
      {$mobile ? '' : 'New agent'}
    </button>
  </header>

  <!-- Mobile overlay backdrop: tap outside drawer to close -->
  {#if $mobile && listOpen}
    <div class="drawer-backdrop" on:click={() => (listOpen = false)} role="presentation"></div>
  {/if}

  <div class="content">
    <AgentList
      mobileOpen={!$mobile || listOpen}
      onSelect={() => {
        if ($mobile) listOpen = false
      }}
    />

    <section class="term-pane">
      {#if !$selected}
        <MissionControl />
      {:else}
        <TicketStatusBar session={$selected} />
        {#if $selected.status === 'idle'}
          <AgentConfig session={$selected} />
        {:else}
          {#key $selected.id}
            <TerminalView session={$selected} />
          {/key}
        {/if}
      {/if}
    </section>
  </div>

  <NewAgentDialog />
  <SettingsModal />
  <Toasts />
  <ConfirmDialog />
  <InstallNudge />
</div>

<style>
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 29;
    background: rgba(0, 0, 0, 0.45);
  }
  .spin {
    display: inline-flex;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
