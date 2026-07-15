<script lang="ts">
  import { onMount } from 'svelte'
  import { nativeStorage, DAEMON_URL_KEY } from '../../nativeStorage'
  import { confirmDialog } from '../../stores'
  import { pushToast } from '../../toast'

  // Only rendered by SettingsModal when nativeStorage.isAvailable() is true
  // (the Capacitor mobile shell) — never shown on web/Electron.

  let currentOrigin = ''
  let value = ''
  let loaded = false
  let saving = false

  function isValidHttpUrl(raw: string): boolean {
    try {
      const u = new URL(raw)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }

  async function load() {
    currentOrigin = typeof location !== 'undefined' ? location.origin : ''
    try {
      value = (await nativeStorage.get(DAEMON_URL_KEY)) ?? ''
    } catch {
      value = ''
    } finally {
      loaded = true
    }
  }

  async function save() {
    const trimmed = value.trim()
    if (!isValidHttpUrl(trimmed)) {
      pushToast('error', 'Enter a valid http(s) URL, e.g. https://your-daemon.example.com')
      return
    }

    const ok = await confirmDialog({
      title: 'Restart Slipstream?',
      message: `The app will restart and connect to ${trimmed}.`,
      confirmLabel: 'Restart',
      cancelLabel: 'Cancel',
    })
    if (!ok) return

    saving = true
    try {
      await nativeStorage.set(DAEMON_URL_KEY, trimmed)
      await nativeStorage.restart()
    } catch {
      pushToast('error', 'Failed to save the daemon URL.')
      saving = false
    }
  }

  onMount(() => {
    load()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Server</span>
</div>
<p class="integration-hint">
  Currently connected to <span class="mono">{currentOrigin}</span>.
</p>
<p class="integration-hint muted">
  Point this app at a different Slipstream daemon. Saving restarts the app so the change takes
  effect.
</p>
<div class="path-add">
  <input
    type="text"
    class="path-input"
    placeholder="https://your-daemon.example.com"
    bind:value
    disabled={!loaded || saving}
  />
  <button
    class="btn btn-outline btn-sm"
    on:click={save}
    disabled={!loaded || saving || !value.trim()}
  >
    {saving ? 'Restarting…' : 'Save & restart'}
  </button>
</div>
