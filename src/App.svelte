<script lang="ts">
  import { onMount } from 'svelte'
  import {
    selected,
    selectedId,
    dialogOpen,
    settingsOpen,
    initFromBackend,
    refreshAndReconcile,
    select,
    subscribeSessionStatus,
    subscribeSessionPr,
    subscribeConnectionChange,
    mobile,
    drawer,
    keyboardInset,
    contentLoading,
    contentResolvedAt,
    contentRefreshNonce,
    historyOpen,
  } from './lib/stores'
  import { icons } from './lib/icons'
  import AgentList from './lib/components/AgentList.svelte'
  import AgentConfig from './lib/components/AgentConfig.svelte'
  import MissionControl from './lib/components/MissionControl.svelte'
  import HistoryView from './lib/components/HistoryView.svelte'
  import TerminalView from './lib/components/TerminalView.svelte'
  import NewAgentDialog from './lib/components/NewAgentDialog.svelte'
  import SettingsModal from './lib/components/SettingsModal.svelte'
  import Toasts from './lib/components/Toasts.svelte'
  import ConfirmDialog from './lib/components/ConfirmDialog.svelte'
  import InstallNudge from './lib/components/InstallNudge.svelte'
  import ThemeMenu from './lib/components/ThemeMenu.svelte'
  import CliStatus from './lib/components/CliStatus.svelte'
  import {
    MOBILE_MEDIA_QUERY,
    DRAWER_MEDIA_QUERY,
    keyboardInset as computeKeyboardInset,
  } from './lib/responsive'

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

  function checkDrawer() {
    drawer.set(window.matchMedia(DRAWER_MEDIA_QUERY).matches)
  }

  function checkViewport() {
    checkMobile()
    checkDrawer()
  }

  onMount(() => {
    const offStatus = subscribeSessionStatus()
    const offPr = subscribeSessionPr()
    const offConnection = subscribeConnectionChange()

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

    checkViewport()
    window.addEventListener('resize', checkViewport)
    window.addEventListener('orientationchange', checkViewport)

    // Track the on-screen keyboard via visualViewport so the bottom bars
    // (mobile composer + .term-actions) can shift up above it.
    const vv = window.visualViewport
    const onVv = () => {
      if (!vv) return
      keyboardInset.set(computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop, vv.scale))
    }
    if (vv) {
      vv.addEventListener('resize', onVv)
      vv.addEventListener('scroll', onVv)
      onVv()
    }

    return () => {
      offStatus()
      offPr()
      offConnection()
      window.removeEventListener('resize', checkViewport)
      window.removeEventListener('orientationchange', checkViewport)
      if (vv) {
        vv.removeEventListener('resize', onVv)
        vv.removeEventListener('scroll', onVv)
      }
    }
  })

  // When an agent is selected on mobile/medium, close the drawer.
  // Keyed off $selectedId (a primitive) rather than $selected: the derived
  // session object re-emits on every PTY status broadcast, which would
  // close the drawer while the user is browsing it (TASK-NBDMS).
  $: if ($selectedId && $drawer) listOpen = false
</script>

<div class="app" style="--kb-inset:{$keyboardInset}px">
  <header class="bar">
    {#if $drawer}
      <!-- Hamburger: toggles the agent list drawer on mobile/medium -->
      <button
        class="btn btn-ghost btn-icon btn-sm"
        title="Agent list"
        on:click={() => (listOpen = !listOpen)}
        aria-label="Toggle agent list"
      >
        {@html icons.terminal}
      </button>
    {/if}
    <div
      class="logo"
      role="button"
      tabindex="0"
      title="Mission control"
      aria-label="Go to mission control"
      on:click={() => select(null)}
      on:keydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select(null)
        }
      }}
    >
      <img src="/icons/icon.svg" alt="Slipstream" class="glyph" />
      <b>Slipstream</b>
      {#if !$mobile}<span class="badge mono">dangerous mode</span>{/if}
      <CliStatus />
    </div>
    {#if $selected}
      <button
        class="btn btn-ghost btn-icon btn-sm"
        title="Mission control"
        on:click={() => select(null)}
        aria-label="Back to mission control"
      >
        {@html icons.home}
      </button>
    {/if}
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
      title="History"
      on:click={() => {
        select(null)
        historyOpen.set(true)
      }}
    >
      {@html icons.history}
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

  <!-- Drawer overlay backdrop: tap outside drawer to close (mobile + medium) -->
  {#if $drawer && listOpen}
    <div class="drawer-backdrop" on:click={() => (listOpen = false)} role="presentation"></div>
  {/if}

  <div class="content">
    <AgentList
      mobileOpen={!$drawer || listOpen}
      onSelect={() => {
        if ($drawer) listOpen = false
      }}
    />

    <section class="term-pane">
      {#if $historyOpen}
        <HistoryView />
      {:else if !$selected}
        <MissionControl />
      {:else if $selected.status === 'idle'}
        <AgentConfig session={$selected} />
      {:else}
        {#key $selected.id}
          <TerminalView session={$selected} />
        {/key}
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
