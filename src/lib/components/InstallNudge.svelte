<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { hasBackend } from '../ipc'
  import { pushSupported, enablePush } from '../push'
  import { pushToast } from '../toast'

  // Web mode gate (same detection as SettingsModal)
  const isWeb =
    hasBackend && (window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb === true

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>
    readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  }

  type Step = 'install' | 'install-ios' | 'notify' | 'notify-blocked' | 'hidden'

  function getDeferred(): BeforeInstallPromptEvent | null | undefined {
    return (window as unknown as { __deferredInstallPrompt?: BeforeInstallPromptEvent | null })
      .__deferredInstallPrompt
  }

  let step: Step = 'hidden'
  let showIosInstructions = false
  let pushLoading = false

  const INSTALL_DISMISSED_KEY = 'slipstream:nudge:install:dismissed'
  const NOTIFY_DISMISSED_KEY = 'slipstream:nudge:notify:dismissed'

  function resolve() {
    if (!isWeb) {
      step = 'hidden'
      return
    }

    const installed =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true

    const canInstall = !!getDeferred()
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !installed

    const installDismissed = !!localStorage.getItem(INSTALL_DISMISSED_KEY)
    const notifyDismissed = !!localStorage.getItem(NOTIFY_DISMISSED_KEY)

    if (!installed) {
      if (!installDismissed) {
        if (canInstall) {
          step = 'install'
          return
        }
        if (isIOS) {
          step = 'install-ios'
          return
        }
      }
      // fell through: desktop/Android browser without captured prompt — try notify
    }

    if (!notifyDismissed && pushSupported() && Notification.permission !== 'granted') {
      if (Notification.permission === 'denied') {
        step = 'notify-blocked'
      } else {
        step = 'notify'
      }
      return
    }

    step = 'hidden'
  }

  function dismissInstall() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
    resolve()
  }

  function dismissNotify() {
    localStorage.setItem(NOTIFY_DISMISSED_KEY, '1')
    resolve()
  }

  function dismiss() {
    if (step === 'install' || step === 'install-ios') dismissInstall()
    else dismissNotify()
  }

  async function handleInstall() {
    const deferred = getDeferred()
    if (!deferred) return
    await deferred.prompt()
    const choice = await deferred.userChoice
    if (choice.outcome === 'accepted') {
      ;(
        window as unknown as { __deferredInstallPrompt?: BeforeInstallPromptEvent | null }
      ).__deferredInstallPrompt = null
      resolve()
    }
    // If dismissed, leave the card — user can manually dismiss
  }

  async function handleEnablePush() {
    pushLoading = true
    try {
      const result = await enablePush({ needs: true, done: true, running: false })
      if (result.ok) {
        pushToast('success', 'Notifications on')
        resolve()
      } else {
        const msg =
          result.reason === 'unsupported'
            ? 'Push notifications are not supported in this browser.'
            : result.reason === 'denied'
              ? 'Notification permission was denied.'
              : (result.reason ?? 'Could not enable notifications.')
        pushToast('error', msg)
      }
    } finally {
      pushLoading = false
    }
  }

  function onInstallable() {
    resolve()
  }
  function onInstalled() {
    resolve()
  }

  onMount(() => {
    if (!isWeb) return
    resolve()
    window.addEventListener('slipstream:installable', onInstallable)
    window.addEventListener('slipstream:installed', onInstalled)
    window.addEventListener('appinstalled', onInstalled)
  })

  onDestroy(() => {
    window.removeEventListener('slipstream:installable', onInstallable)
    window.removeEventListener('slipstream:installed', onInstalled)
    window.removeEventListener('appinstalled', onInstalled)
  })
</script>

{#if step !== 'hidden'}
  <div class="nudge-card" role="complementary" aria-label="Setup nudge">
    <!-- signal dot -->
    <div
      class="signal-dot"
      class:signal-primary={step === 'install' || step === 'install-ios'}
      class:signal-amber={step === 'notify' || step === 'notify-blocked'}
    ></div>

    <!-- dismiss × button top-right -->
    <button
      type="button"
      class="btn btn-ghost btn-icon btn-sm dismiss-btn"
      aria-label="Dismiss"
      on:click={dismiss}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg
      >
    </button>

    <div class="nudge-body">
      {#if step === 'install' || step === 'install-ios'}
        <p class="nudge-headline">Keep an eye on your agents from anywhere</p>
        <p class="nudge-text">Install Slipstream for a home-screen icon and background alerts.</p>
        <div class="nudge-actions">
          {#if step === 'install'}
            <button type="button" class="btn btn-primary btn-sm" on:click={handleInstall}
              >Install app</button
            >
          {:else}
            <button
              type="button"
              class="btn btn-primary btn-sm"
              on:click={() => (showIosInstructions = !showIosInstructions)}>How?</button
            >
          {/if}
          <button type="button" class="btn btn-ghost btn-sm" on:click={dismissInstall}
            >Not now</button
          >
        </div>
        {#if showIosInstructions}
          <p class="ios-hint">
            Tap the Share button in your browser's toolbar, then choose 'Add to Home Screen.'
          </p>
        {/if}
      {:else if step === 'notify'}
        <p class="nudge-headline">Get pinged when an agent needs you</p>
        <p class="nudge-text">
          Agents keep running after you close the tab. Know the moment one finishes or needs a
          decision.
        </p>
        <div class="nudge-actions">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            on:click={handleEnablePush}
            disabled={pushLoading}>Turn on notifications</button
          >
          <button type="button" class="btn btn-ghost btn-sm" on:click={dismissNotify}
            >Not now</button
          >
        </div>
      {:else if step === 'notify-blocked'}
        <p class="nudge-headline">Alerts are turned off</p>
        <p class="nudge-text">
          Re-enable notifications in your browser settings to hear from your agents.
        </p>
        <div class="nudge-actions">
          <button type="button" class="btn btn-ghost btn-sm" on:click={dismissNotify}>Got it</button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .nudge-card {
    position: fixed;
    bottom: 20px;
    left: 20px;
    max-width: 360px;
    width: calc(100% - 40px);
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) + 2px);
    box-shadow: var(--shadow);
    padding: 16px 16px 16px 44px;
    z-index: 150;
    display: flex;
    flex-direction: column;
    gap: 0;
    animation: nudgeSlideIn 0.28s ease both;
  }

  @keyframes nudgeSlideIn {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .nudge-card {
      animation: none;
    }
  }

  /* Signal dot with pulsing rings */
  .signal-dot {
    position: absolute;
    top: 18px;
    left: 16px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .signal-primary {
    background: hsl(var(--primary));
    box-shadow: 0 0 0 0 hsl(var(--primary) / 0.5);
    animation: nudgePulse 2.4s infinite;
  }

  .signal-amber {
    background: hsl(var(--st-needs));
    box-shadow: 0 0 0 0 hsl(var(--st-needs) / 0.5);
    animation: nudgePulseAmber 2.4s infinite;
  }

  @keyframes nudgePulse {
    0% {
      box-shadow: 0 0 0 0 hsl(var(--primary) / 0.5);
    }
    70% {
      box-shadow: 0 0 0 8px hsl(var(--primary) / 0);
    }
    100% {
      box-shadow: 0 0 0 0 hsl(var(--primary) / 0);
    }
  }

  @keyframes nudgePulseAmber {
    0% {
      box-shadow: 0 0 0 0 hsl(var(--st-needs) / 0.5);
    }
    70% {
      box-shadow: 0 0 0 8px hsl(var(--st-needs) / 0);
    }
    100% {
      box-shadow: 0 0 0 0 hsl(var(--st-needs) / 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .signal-primary,
    .signal-amber {
      animation: none;
    }
  }

  .dismiss-btn {
    position: absolute;
    top: 8px;
    right: 8px;
  }

  .dismiss-btn:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }

  .nudge-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .nudge-headline {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.4;
    color: hsl(var(--foreground));
  }

  .nudge-text {
    font-size: 12.5px;
    color: hsl(var(--muted-foreground));
    line-height: 1.5;
  }

  .nudge-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    flex-wrap: wrap;
  }

  .ios-hint {
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    line-height: 1.5;
    background: hsl(var(--muted) / 0.4);
    border-radius: var(--radius);
    padding: 8px 10px;
    margin-top: 4px;
  }

  /* Mobile: bottom sheet */
  @media (max-width: 700px) {
    .nudge-card {
      left: 0;
      right: 0;
      bottom: 0;
      max-width: none;
      width: 100%;
      border-radius: calc(var(--radius) + 2px) calc(var(--radius) + 2px) 0 0;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
      padding-left: max(44px, calc(env(safe-area-inset-left) + 44px));
      padding-right: max(16px, env(safe-area-inset-right));
      animation: nudgeSlideUp 0.28s ease both;
    }

    @keyframes nudgeSlideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .nudge-card {
        animation: none;
      }
    }
  }
</style>
