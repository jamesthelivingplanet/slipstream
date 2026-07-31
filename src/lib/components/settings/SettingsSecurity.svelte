<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { checkBiometricAvailability, promptBiometric } from '../../biometric'
  import type { BiometricAvailability } from '../../biometric'
  import { isBiometricLockEnabled, setBiometricLockEnabled } from '../../nativeStorage'
  import { pushToast } from '../../toast'
  import { createPairingCode, hasBackend } from '../../ipc'
  import type { PairingCodeDTO } from '../../../../electron/shared/contract.js'

  // Rendered by SettingsModal on every platform (not gated on
  // nativeStorage.isAvailable(), unlike the "Server" tab) — the "Pair a
  // device" section below (self-service device onboarding, docs/SECURITY.md's
  // device-pairing-codes section) is NOT mobile-specific; pairing is more
  // often initiated FROM an already-set-up desktop/web session TOWARD a new
  // phone. The "Fingerprint unlock" section below is mobile-only in effect
  // (checkBiometricAvailability()/promptBiometric() report "unsupported"
  // outside the Capacitor shell — see biometric.ts), but degrades gracefully
  // via unavailableReason() rather than needing its own gate here.

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

  // ── Pair a device (self-service onboarding, docs/SECURITY.md) ────────────
  //
  // createPairingCode() is an authenticated, owner-scoped RPC — the code it
  // returns is bound server-side to THIS session's identity, never to
  // anything supplied here. The new device redeems it at the unauthenticated
  // POST /pair endpoint (see TokenGate.svelte).
  let pairingCode: PairingCodeDTO | null = null
  let pairingBusy = false
  let pairingError = ''
  let qrDataUrl = ''
  let remainingMs = 0
  let countdownTimer: ReturnType<typeof setInterval> | undefined

  function stopCountdown() {
    if (countdownTimer !== undefined) {
      clearInterval(countdownTimer)
      countdownTimer = undefined
    }
  }

  function startCountdown(expiresAt: number) {
    stopCountdown()
    remainingMs = Math.max(0, expiresAt - Date.now())
    countdownTimer = setInterval(() => {
      remainingMs = Math.max(0, expiresAt - Date.now())
      if (remainingMs <= 0) {
        // Expired client-side — the code is already unusable server-side too
        // (same TTL), so just clear the display rather than showing a stale
        // code the server would reject.
        stopCountdown()
        pairingCode = null
        qrDataUrl = ''
      }
    }, 1000)
  }

  $: countdownLabel = (() => {
    const totalSec = Math.ceil(remainingMs / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  })()

  async function generatePairingCode() {
    pairingError = ''
    pairingBusy = true
    qrDataUrl = ''
    try {
      const result = await createPairingCode()
      pairingCode = result
      startCountdown(result.expiresAt)
      try {
        // qrcode is already a runtime dependency (SettingsIntegrations.svelte's
        // existing token-pairing-link QR uses it) — dynamically imported so
        // it isn't bundled for users who never open this panel.
        const QRCode = await import('qrcode')
        // Fragment (#pair=...), deliberately NOT a query string: a fragment
        // is never sent in the HTTP request (not even for the very first
        // page load), so it can never land in a reverse-proxy access log —
        // see docs/SECURITY.md's device-pairing-codes section on why the
        // code must never travel as ?pair=. TokenGate.svelte reads this same
        // hash shape on mount to prefill the code field.
        const deepLink = `${location.origin}/#pair=${encodeURIComponent(result.code)}`
        qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 220 })
      } catch {
        // Best-effort: the plain code below still works without a QR image.
      }
    } catch (e) {
      pairingError = e instanceof Error ? e.message : "Couldn't generate a pairing code."
    } finally {
      pairingBusy = false
    }
  }

  function dismissPairingCode() {
    stopCountdown()
    pairingCode = null
    qrDataUrl = ''
    pairingError = ''
  }

  onDestroy(() => {
    stopCountdown()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Security</span>
</div>

<div class="security-section">
  <span class="lbl-f">Pair a device</span>
  <p class="integration-hint">
    Generate a short-lived code to sign a new device into your account, without an operator handing
    out a token. On the new device, open its connect screen and enter the code (or scan it) before
    it expires.
  </p>
  {#if !hasBackend}
    <p class="integration-hint muted">Not available in design mode (no backend).</p>
  {:else}
    {#if pairingError}
      <p class="integration-hint" style="color:hsl(var(--st-error))">{pairingError}</p>
    {/if}
    {#if !pairingCode}
      <button class="btn btn-primary btn-sm" on:click={generatePairingCode} disabled={pairingBusy}>
        {pairingBusy ? 'Generating…' : 'Pair a device'}
      </button>
    {:else}
      <div class="pairing-panel">
        <div class="pairing-code mono">{pairingCode.code}</div>
        <div class="integration-hint muted">Expires in {countdownLabel}</div>
        {#if qrDataUrl}
          <img class="pairing-qr" src={qrDataUrl} alt="QR code for pairing a new device" />
        {/if}
        <button class="btn btn-outline btn-sm" on:click={dismissPairingCode}>Done</button>
      </div>
    {/if}
  {/if}
</div>

<div class="security-section">
  <span class="lbl-f">Fingerprint unlock</span>
  <p class="integration-hint">
    Protects your saved server token behind your fingerprint every time the app is opened. It does
    not replace your device lock screen.
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
</div>

<style>
  .security-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 14px;
    margin-bottom: 4px;
    border-bottom: 1px solid hsl(var(--border));
  }

  .security-section:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .pairing-panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .pairing-code {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.02em;
    background: hsl(var(--muted) / 0.4);
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    padding: 8px 12px;
    word-break: break-all;
  }

  .pairing-qr {
    width: 160px;
    height: 160px;
    border-radius: var(--radius);
    background: #fff;
    padding: 6px;
  }
</style>
