<script lang="ts">
  import { onMount } from 'svelte'
  import { normalizeServerUrl } from '../serverUrl'

  /** Shown in web mode when no token is stored/provided, or on auth failure. */
  export let error: string = ''
  /** Prefilled server origin — the stored override, or location.origin. */
  export let server: string = ''
  export let onSubmit: (server: string, token: string) => void

  let serverValue = server
  let token = ''
  let pairingCode = ''
  let pairing = false
  let localError = ''
  let serverInputEl: HTMLInputElement
  let tokenInputEl: HTMLInputElement

  onMount(() => {
    // A "Pair a device" QR (Settings → Security on an already-authenticated
    // device, docs/SECURITY.md's device-pairing-codes section) deep-links to
    // this same origin with the code in the URL FRAGMENT — never a query
    // string, since a fragment is never sent in the HTTP request (not even
    // for this very first page load), so it can't land in a reverse-proxy
    // access log the way a `?pair=` would. Prefill the pairing-code field
    // and immediately strip the fragment from the visible/history URL.
    const match = /(?:^|&)pair=([^&]+)/.exec(location.hash.replace(/^#/, ''))
    if (match) {
      pairingCode = decodeURIComponent(match[1])
      history.replaceState(null, '', location.pathname + location.search)
    }

    if (!serverValue.trim()) {
      serverInputEl?.focus()
    } else if (pairingCode) {
      // Nothing to focus into for the pairing-code path — the code is
      // already filled in; leave focus alone rather than jumping to Token.
    } else {
      tokenInputEl?.focus()
    }
  })

  $: canSubmit = !!serverValue.trim() && !!token.trim()
  $: canPair = !!serverValue.trim() && !!pairingCode.trim() && !pairing

  function normalizedOrError(): string | null {
    const normalized = normalizeServerUrl(serverValue, location.protocol)
    if (!normalized) {
      localError = 'Enter a valid server URL, e.g. https://your-server.example.com'
      return null
    }
    localError = ''
    return normalized
  }

  function submit() {
    if (!canSubmit) return
    const normalized = normalizedOrError()
    if (!normalized) return
    onSubmit(normalized, token.trim())
  }

  /** Redeems a pairing code at the unauthenticated POST /pair endpoint
   *  (docs/SECURITY.md's device-pairing-codes section) and, on success,
   *  hands the minted device token to the same onSubmit path a typed token
   *  would use — the rest of the connect flow is identical either way. */
  async function submitPairingCode() {
    if (!canPair) return
    const normalized = normalizedOrError()
    if (!normalized) return
    pairing = true
    try {
      const res = await fetch(`${normalized}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The code travels in the POST body, never a query string — see
        // docs/SECURITY.md's device-pairing-codes section on why.
        body: JSON.stringify({ code: pairingCode.trim() }),
      })
      if (!res.ok) {
        localError = 'Invalid or expired pairing code.'
        return
      }
      const body = (await res.json()) as { token?: string }
      if (!body.token) {
        localError = 'Invalid or expired pairing code.'
        return
      }
      onSubmit(normalized, body.token)
    } catch {
      localError = "Couldn't reach the server. Check the URL and try again."
    } finally {
      pairing = false
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') submit()
  }

  function pairingKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') void submitPairingCode()
  }
</script>

<div class="gate-bg">
  <div class="gate-card">
    <div class="gate-logo">
      <img src="/icons/nulliel-glyph.svg" alt="Slipstream" class="glyph" />
      <b>Slipstream</b>
    </div>
    <h2>Connect to your server</h2>
    <p class="gate-hint">
      Enter the URL of the Slipstream server and its access token. The URL is prefilled when the app
      is served by the server itself.
    </p>

    {#if localError || error}
      <div class="gate-error">{localError || error}</div>
    {/if}

    <div class="gate-field">
      <label class="gate-label" for="gate-server-input">Server URL</label>
      <input
        id="gate-server-input"
        type="text"
        class="gate-input"
        placeholder="https://your-server.example.com"
        bind:value={serverValue}
        bind:this={serverInputEl}
        on:keydown={keydown}
      />
    </div>

    <div class="gate-field">
      <label class="gate-label" for="gate-token-input">Token</label>
      <input
        id="gate-token-input"
        type="password"
        class="gate-input"
        placeholder="Token"
        bind:value={token}
        bind:this={tokenInputEl}
        on:keydown={keydown}
      />
    </div>

    <button class="btn btn-primary gate-btn" on:click={submit} disabled={!canSubmit}>
      Connect
    </button>

    <div class="gate-divider"><span>or</span></div>

    <div class="gate-field">
      <label class="gate-label" for="gate-pair-input">Pairing code</label>
      <input
        id="gate-pair-input"
        type="text"
        class="gate-input"
        placeholder="Paste or scan a pairing code"
        bind:value={pairingCode}
        on:keydown={pairingKeydown}
      />
    </div>

    <button class="btn btn-outline gate-btn" on:click={submitPairingCode} disabled={!canPair}>
      {pairing ? 'Pairing…' : 'Pair this device'}
    </button>
  </div>
</div>

<style>
  .gate-bg {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: hsl(var(--background));
  }

  .gate-card {
    width: 340px;
    max-width: 90vw;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) + 2px);
    box-shadow: var(--shadow);
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .gate-logo {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 4px;
  }

  .gate-logo .glyph {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    object-fit: contain;
  }

  .gate-logo b {
    font-weight: 600;
    font-size: 14px;
  }

  h2 {
    font-size: 17px;
    font-weight: 600;
    color: hsl(var(--foreground));
    margin: 0;
  }

  .gate-hint {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    line-height: 1.5;
    margin: 0;
  }

  .gate-error {
    font-size: 13px;
    color: hsl(var(--st-error));
    background: hsl(var(--st-error) / 0.1);
    border: 1px solid hsl(var(--st-error) / 0.3);
    border-radius: var(--radius);
    padding: 8px 12px;
  }

  .gate-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .gate-label {
    font-size: 12px;
    color: hsl(var(--muted-foreground));
  }

  .gate-input {
    width: 100%;
    height: 38px;
    background: hsl(var(--background));
    border: 1px solid hsl(var(--input));
    border-radius: var(--radius);
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    padding: 0 12px;
  }

  .gate-input:focus {
    outline: none;
    border-color: hsl(var(--ring));
    box-shadow: 0 0 0 3px hsl(var(--ring) / 0.12);
  }

  .gate-btn {
    width: 100%;
    height: 38px;
  }

  .gate-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    color: hsl(var(--muted-foreground));
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .gate-divider::before,
  .gate-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: hsl(var(--border));
  }
</style>
