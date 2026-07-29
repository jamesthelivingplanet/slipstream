<script lang="ts">
  import { onMount } from 'svelte'
  import { checkBiometricAvailability, promptBiometric } from '../../biometric'
  import type { BiometricAvailability } from '../../biometric'
  import { isBiometricLockEnabled, setBiometricLockEnabled } from '../../nativeStorage'
  import { pushToast } from '../../toast'

  // Only rendered by SettingsModal when nativeStorage.isAvailable() is true
  // (the Capacitor mobile shell) — never shown on web/Electron, mirroring
  // SettingsServer.svelte's tab.

  let availability: BiometricAvailability = { available: false, status: 'unsupported' }
  let enabled = false
  let loaded = false
  let busy = false
  let error = ''

  /** Mirrors main.ts's (and App.svelte's) biometricErrorMessage — same
   *  code→message mapping and wording, so a failed "turn this on" prompt
   *  here reads identically to a failed boot-time/re-lock unlock. */
  function biometricErrorMessage(code: string | undefined, err: string | undefined): string {
    switch (code) {
      case 'user-canceled':
        return 'Unlock canceled.'
      case 'lockout':
        return 'Too many attempts. Try again later, or use your device PIN.'
      case 'no-credential':
        return 'No screen lock is set up on this device.'
      default:
        return err || "Couldn't verify. Try again."
    }
  }

  function unavailableReason(status: BiometricAvailability['status']): string {
    switch (status) {
      case 'none-enrolled':
        return 'No fingerprint or screen lock is enrolled on this device. Add one in Android Settings.'
      case 'no-hardware':
      case 'unsupported':
        return 'This device has no biometric hardware.'
      case 'hw-unavailable':
        return 'Biometric hardware is currently unavailable.'
      case 'security-update-required':
        return 'A device security update is required.'
      default:
        return "Biometric unlock isn't available on this device."
    }
  }

  async function load() {
    try {
      availability = await checkBiometricAvailability()
      enabled = await isBiometricLockEnabled()
    } finally {
      loaded = true
    }
  }

  // Enabling must prove the user can actually pass the gate FIRST — a
  // preference flip with no successful prompt behind it would let someone
  // lock themselves out of their own saved token. Only a successful
  // promptBiometric() persists the preference.
  async function handleEnable() {
    error = ''
    busy = true
    try {
      const result = await promptBiometric({
        title: 'Confirm fingerprint',
        subtitle: 'Verify you can unlock Slipstream before turning this on',
      })
      if (result.authenticated) {
        await setBiometricLockEnabled(true)
        enabled = true
        pushToast('success', 'Fingerprint unlock enabled')
      } else {
        error = biometricErrorMessage(result.code, result.error)
        pushToast('error', error)
      }
    } finally {
      busy = false
    }
  }

  // Disabling takes effect immediately — no confirmation needed to turn
  // protection OFF.
  async function handleDisable() {
    busy = true
    try {
      await setBiometricLockEnabled(false)
      enabled = false
      error = ''
      pushToast('success', 'Fingerprint unlock disabled')
    } finally {
      busy = false
    }
  }

  onMount(() => {
    load()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Security</span>
</div>
<p class="integration-hint">
  Protects your saved server token behind your fingerprint every time the app is opened. It does not
  replace your device lock screen.
</p>
{#if loaded && !availability.available}
  <p class="integration-hint muted">{unavailableReason(availability.status)}</p>
{/if}
{#if error}
  <p class="integration-hint" style="color:hsl(var(--st-error))">{error}</p>
{/if}
<div class="notify-row">
  <span class="lbl-f" style="margin-bottom:0">Require fingerprint to unlock</span>
  {#if enabled}
    <button class="btn btn-outline btn-sm" on:click={handleDisable} disabled={busy || !loaded}>
      Disable
    </button>
  {:else}
    <button
      class="btn btn-primary btn-sm"
      on:click={handleEnable}
      disabled={busy || !loaded || !availability.available}
    >
      {busy ? 'Confirming…' : 'Enable'}
    </button>
  {/if}
</div>
