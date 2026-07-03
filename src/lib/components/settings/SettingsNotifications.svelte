<script lang="ts">
  import { onMount } from 'svelte'
  import { hasBackend } from '../../ipc'
  import { pushToast } from '../../toast'
  import { pushSupported, enablePush, updatePrefs, disablePush, loadPrefs } from '../../push'
  import type { NotifyPrefs } from '../../../../electron/shared/contract.js'

  let pushEnabled = false
  let prefs: NotifyPrefs = { needs: true, done: true, running: false }
  let pushLoading = false

  // Web mode: push notifications are only available in the installed web app (PWA).
  // We detect web mode by checking the explicit marker set in main.ts on the
  // WS boot path. The Electron preload never sets this marker, so isWeb is
  // false on desktop even though window.electron is also absent there.
  const isWeb =
    hasBackend && (window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb === true

  async function initNotifications() {
    if (!isWeb || !pushSupported()) return
    try {
      const loaded = await loadPrefs()
      if (loaded) {
        pushEnabled = true
        prefs = loaded
      } else {
        pushEnabled = false
        prefs = { needs: true, done: true, running: false }
      }
    } catch {
      // ignore
    }
  }

  async function handleEnablePush() {
    pushLoading = true
    try {
      const result = await enablePush(prefs)
      if (result.ok) {
        pushEnabled = true
        pushToast('success', 'Notifications enabled')
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

  async function handleDisablePush() {
    pushLoading = true
    try {
      await disablePush()
      pushEnabled = false
      pushToast('success', 'Notifications disabled')
    } catch {
      pushToast('error', 'Failed to disable notifications.')
    } finally {
      pushLoading = false
    }
  }

  async function handlePrefsChange() {
    if (!pushEnabled) return
    const ok = await updatePrefs(prefs)
    if (!ok) pushToast('error', 'Failed to update notification preferences.')
  }

  onMount(() => {
    initNotifications()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Notifications</span>
</div>
{#if !isWeb}
  <p class="integration-hint muted">
    Push notifications are available in the installed web app (PWA). Open Slipstream in your
    mobile/desktop browser to enable them.
  </p>
{:else if !pushSupported()}
  <p class="integration-hint muted">Push notifications are not supported in this browser.</p>
{:else}
  <div class="notify-row">
    <span class="lbl-f" style="margin-bottom:0">Enable notifications</span>
    {#if pushEnabled}
      <button class="btn btn-outline btn-sm" on:click={handleDisablePush} disabled={pushLoading}>
        Disable
      </button>
    {:else}
      <button class="btn btn-primary btn-sm" on:click={handleEnablePush} disabled={pushLoading}>
        Enable
      </button>
    {/if}
  </div>
  {#if pushEnabled}
    <div>
      <span class="lbl-f">Notify me when an agent…</span>
      <label class="notify-check">
        <input type="checkbox" bind:checked={prefs.needs} on:change={handlePrefsChange} />
        Needs attention
      </label>
      <label class="notify-check">
        <input type="checkbox" bind:checked={prefs.done} on:change={handlePrefsChange} />
        Is done
      </label>
      <label class="notify-check">
        <input type="checkbox" bind:checked={prefs.running} on:change={handlePrefsChange} />
        Starts running
      </label>
    </div>
  {/if}
{/if}
