<script lang="ts">
  import { onMount } from 'svelte'
  import { cliStatus, cliChecking, refreshCliStatus } from '../../stores'
  import {
    hasBackend,
    listGitProviders,
    getGitHostConfig,
    setGitHostConfig,
    getTicketSettings,
    setTicketSettings,
    listTicketScopes,
  } from '../../ipc'
  import { pushToast } from '../../toast'
  import SettingsSection from './SettingsSection.svelte'
  import type {
    ScopeOption,
    TicketSourceSettings,
    GitHost,
    GitProviderInfoDTO,
  } from '../../../../electron/shared/contract.js'

  function emptySettings(): TicketSourceSettings {
    return {
      configured: false,
      scopeKeys: [],
      onlyMine: true,
      apiKey: '',
      baseUrl: '',
      email: '',
      apiToken: '',
    }
  }

  // ── Linear ─────────────────────────────────────────────────────────────
  let linearSettings: TicketSourceSettings = emptySettings()
  let linearPending = false
  let linearScopes: ScopeOption[] = []
  let linearScopesLoading = false
  let linearScopesError: string | null = null

  async function loadLinearSettings() {
    if (!hasBackend) return
    try {
      linearSettings = await getTicketSettings('linear')
    } catch {
      // ignore
    }
  }

  async function saveLinearSettings() {
    if (!hasBackend) return
    linearPending = true
    try {
      await setTicketSettings('linear', linearSettings)
      pushToast('success', 'Linear settings saved')
      await loadLinearSettings()
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save Linear settings')
    } finally {
      linearPending = false
    }
  }

  async function loadLinearScopes() {
    if (!hasBackend) return
    linearScopesLoading = true
    linearScopesError = null
    try {
      linearScopes = await listTicketScopes('linear')
    } catch (e) {
      linearScopesError = e instanceof Error ? e.message : 'Failed to load teams'
    } finally {
      linearScopesLoading = false
    }
  }

  function toggleLinearScope(key: string) {
    const set = new Set(linearSettings.scopeKeys)
    if (set.has(key)) set.delete(key)
    else set.add(key)
    linearSettings = { ...linearSettings, scopeKeys: [...set] }
  }

  // ── Jira ───────────────────────────────────────────────────────────────
  let jiraSettings: TicketSourceSettings = emptySettings()
  let jiraPending = false
  let jiraScopes: ScopeOption[] = []
  let jiraScopesLoading = false
  let jiraScopesError: string | null = null

  async function loadJiraSettings() {
    if (!hasBackend) return
    try {
      jiraSettings = await getTicketSettings('jira')
    } catch {
      // ignore
    }
  }

  async function saveJiraSettings() {
    if (!hasBackend) return
    jiraPending = true
    try {
      await setTicketSettings('jira', jiraSettings)
      pushToast('success', 'Jira settings saved')
      await loadJiraSettings()
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save Jira settings')
    } finally {
      jiraPending = false
    }
  }

  async function loadJiraScopes() {
    if (!hasBackend) return
    jiraScopesLoading = true
    jiraScopesError = null
    try {
      jiraScopes = await listTicketScopes('jira')
    } catch (e) {
      jiraScopesError = e instanceof Error ? e.message : 'Failed to load projects'
    } finally {
      jiraScopesLoading = false
    }
  }

  function toggleJiraScope(key: string) {
    const set = new Set(jiraSettings.scopeKeys)
    if (set.has(key)) set.delete(key)
    else set.add(key)
    jiraSettings = { ...jiraSettings, scopeKeys: [...set] }
  }

  // ── Git hosts ──────────────────────────────────────────────────────────
  interface GitHostFormState {
    token: string
    username: string
    baseUrl: string
    pending: boolean
  }

  let gitProviders: GitProviderInfoDTO[] = []
  let gitHostState: Record<string, GitHostFormState> = {}

  function emptyGitHostState(): GitHostFormState {
    return { token: '', username: '', baseUrl: '', pending: false }
  }

  async function loadGitProviders() {
    if (!hasBackend) return
    try {
      const providers = await listGitProviders()
      // Seed defaults synchronously so the {#each} below never indexes a
      // missing gitHostState entry while the per-host config loads below.
      for (const p of providers) {
        if (!gitHostState[p.id]) gitHostState[p.id] = emptyGitHostState()
      }
      gitProviders = providers
      gitHostState = { ...gitHostState }

      await Promise.all(
        providers.map(async (p) => {
          try {
            const cfg = await getGitHostConfig(p.id)
            gitHostState[p.id] = {
              token: cfg.token ?? '',
              username: cfg.username ?? '',
              baseUrl: cfg.baseUrl ?? '',
              pending: false,
            }
            gitHostState = { ...gitHostState }
          } catch {
            // ignore — leave the empty default for this host
          }
        }),
      )
    } catch {
      // ignore
    }
  }

  async function saveGitHost(provider: GitProviderInfoDTO) {
    if (!hasBackend) return
    const state = gitHostState[provider.id]
    if (!state) return
    state.pending = true
    gitHostState = { ...gitHostState }
    try {
      await setGitHostConfig(provider.id as GitHost, {
        token: state.token.trim(),
        username: state.username.trim(),
        baseUrl: state.baseUrl.trim(),
      })
      pushToast('success', `${provider.displayName} settings saved`)
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      state.pending = false
      gitHostState = { ...gitHostState }
    }
  }

  function mcpRelTime(ms: number): string {
    const diff = Math.max(0, Date.now() - ms)
    const sec = Math.round(diff / 1000)
    if (sec < 5) return 'just now'
    if (sec < 60) return `${sec}s`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m`
    const hr = Math.round(min / 60)
    if (hr < 24) return `${hr}h`
    const day = Math.round(hr / 24)
    return `${day}d`
  }

  onMount(() => {
    loadLinearSettings()
    loadJiraSettings()
    loadGitProviders()
    refreshCliStatus()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Integrations</span>
</div>
<SettingsSection title="slipstream CLI">
  <p class="integration-hint">
    Lets an agent report status, record checkpoints, publish artifacts, and open the PR back to
    Slipstream.
  </p>
  <div class="mcp-settings-row">
    <span
      class="mcp-settings-dot"
      class:up={$cliStatus?.up}
      class:down={$cliStatus && !$cliStatus.up}
    ></span>
    <span class="mcp-settings-state"
      >{$cliStatus === null ? 'Checking' : $cliStatus.up ? 'Up' : 'Unreachable'}</span
    >
  </div>
  {#if $cliStatus?.commands?.length}
    <div class="mcp-settings-tools">
      {#each $cliStatus.commands as command (command)}
        <span class="mcp-settings-tool mono">{command}</span>
      {/each}
    </div>
  {/if}
  {#if $cliStatus}
    <p class="integration-hint muted">
      Checked {mcpRelTime($cliStatus.checkedAt)} ago{#if $cliStatus.lastActivityAt}
        · Last used {mcpRelTime($cliStatus.lastActivityAt)} ago{:else}
        · No agent has used it yet{/if}
    </p>
  {/if}
  {#if $cliStatus?.error}
    <p class="mcp-settings-error">{$cliStatus.error}</p>
  {/if}
  <button
    class="btn btn-outline btn-sm"
    on:click={() => refreshCliStatus()}
    disabled={$cliChecking}
  >
    {$cliChecking ? 'Checking…' : 'Test connection'}
  </button>
</SettingsSection>

<SettingsSection title="Linear">
  <p class="integration-hint">Personal API key from Linear → Settings → API → Personal API keys.</p>
  <div class="path-add">
    <input
      type="password"
      class="path-input"
      placeholder="lin_api_••••••••••••••••••••••••••••••••"
      bind:value={linearSettings.apiKey}
      disabled={linearPending || !hasBackend}
    />
    <button
      class="btn btn-outline btn-sm"
      on:click={saveLinearSettings}
      disabled={!linearSettings.apiKey.trim() || linearPending || !hasBackend}
    >
      Save
    </button>
  </div>
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {:else if linearSettings.configured}
    <div class="scope-section">
      <div class="scope-header">
        <span class="scope-title">Teams</span>
        <button
          class="btn btn-outline btn-sm"
          on:click={loadLinearScopes}
          disabled={linearScopesLoading}
        >
          {linearScopesLoading ? 'Loading…' : linearScopes.length ? 'Refresh teams' : 'Load teams'}
        </button>
      </div>
      <p class="integration-hint">
        Only tickets from checked teams are shown. Leave all unchecked to include every team.
      </p>
      {#if linearScopesError}
        <p class="mcp-settings-error">{linearScopesError}</p>
      {/if}
      {#if linearScopes.length}
        <div class="scope-list">
          {#each linearScopes as scope (scope.id)}
            <label class="notify-check">
              <input
                type="checkbox"
                checked={linearSettings.scopeKeys.includes(scope.key)}
                on:change={() => toggleLinearScope(scope.key)}
              />
              <span class="mono">{scope.key}</span> — {scope.name}
            </label>
          {/each}
        </div>
      {/if}
      <label class="notify-check">
        <input type="checkbox" bind:checked={linearSettings.onlyMine} />
        Only my/unassigned tickets
      </label>
      <p class="integration-hint">
        Hides tickets assigned to teammates; keeps tickets assigned to you or nobody.
      </p>
      <button
        class="btn btn-outline btn-sm"
        on:click={saveLinearSettings}
        disabled={linearPending || !hasBackend}
      >
        Save team &amp; filter settings
      </button>
    </div>
  {/if}
</SettingsSection>

<SettingsSection title="Jira Cloud">
  <p class="integration-hint">
    Base URL, account email, and an API token from Atlassian account settings → Security → API
    tokens.
  </p>
  <div class="repo-settings-field">
    <input
      type="text"
      class="path-input"
      placeholder="https://yourteam.atlassian.net"
      bind:value={jiraSettings.baseUrl}
      disabled={jiraPending || !hasBackend}
    />
  </div>
  <div class="repo-settings-field">
    <input
      type="text"
      class="path-input"
      placeholder="you@example.com"
      bind:value={jiraSettings.email}
      disabled={jiraPending || !hasBackend}
    />
  </div>
  <div class="path-add">
    <input
      type="password"
      class="path-input"
      placeholder="API token"
      bind:value={jiraSettings.apiToken}
      disabled={jiraPending || !hasBackend}
    />
    <button
      class="btn btn-outline btn-sm"
      on:click={saveJiraSettings}
      disabled={!jiraSettings.baseUrl.trim() ||
        !jiraSettings.email.trim() ||
        !jiraSettings.apiToken.trim() ||
        jiraPending ||
        !hasBackend}
    >
      Save
    </button>
  </div>
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {:else if jiraSettings.configured}
    <div class="scope-section">
      <div class="scope-header">
        <span class="scope-title">Projects</span>
        <button
          class="btn btn-outline btn-sm"
          on:click={loadJiraScopes}
          disabled={jiraScopesLoading}
        >
          {jiraScopesLoading
            ? 'Loading…'
            : jiraScopes.length
              ? 'Refresh projects'
              : 'Load projects'}
        </button>
      </div>
      <p class="integration-hint">
        Only tickets from checked projects are shown. Leave all unchecked to include every project.
      </p>
      {#if jiraScopesError}
        <p class="mcp-settings-error">{jiraScopesError}</p>
      {/if}
      {#if jiraScopes.length}
        <div class="scope-list">
          {#each jiraScopes as scope (scope.id)}
            <label class="notify-check">
              <input
                type="checkbox"
                checked={jiraSettings.scopeKeys.includes(scope.key)}
                on:change={() => toggleJiraScope(scope.key)}
              />
              <span class="mono">{scope.key}</span> — {scope.name}
            </label>
          {/each}
        </div>
      {/if}
      <label class="notify-check">
        <input type="checkbox" bind:checked={jiraSettings.onlyMine} />
        Only my/unassigned tickets
      </label>
      <p class="integration-hint">
        Hides tickets assigned to teammates; keeps tickets assigned to you or nobody.
      </p>
      <button
        class="btn btn-outline btn-sm"
        on:click={saveJiraSettings}
        disabled={jiraPending || !hasBackend}
      >
        Save project &amp; filter settings
      </button>
    </div>
  {/if}
</SettingsSection>

{#each gitProviders as provider (provider.id)}
  <SettingsSection title="{provider.displayName} Token">
    <p class="integration-hint">{provider.tokenHint}</p>
    {#if provider.needsUsername}
      <div class="repo-settings-field">
        <input
          type="text"
          class="path-input"
          placeholder="Username"
          bind:value={gitHostState[provider.id].username}
          disabled={gitHostState[provider.id].pending || !hasBackend}
        />
      </div>
    {/if}
    {#if provider.needsBaseUrl}
      <div class="repo-settings-field">
        <input
          type="text"
          class="path-input"
          placeholder="https://git.example.com"
          bind:value={gitHostState[provider.id].baseUrl}
          disabled={gitHostState[provider.id].pending || !hasBackend}
        />
      </div>
    {/if}
    <div class="path-add">
      <input
        type="password"
        class="path-input"
        placeholder="Token"
        bind:value={gitHostState[provider.id].token}
        disabled={gitHostState[provider.id].pending || !hasBackend}
      />
      <button
        class="btn btn-outline btn-sm"
        on:click={() => saveGitHost(provider)}
        disabled={!gitHostState[provider.id].token.trim() ||
          gitHostState[provider.id].pending ||
          !hasBackend}
      >
        Save
      </button>
    </div>
    {#if !hasBackend}
      <p class="integration-hint muted">Backend not available in browser-only mode.</p>
    {/if}
  </SettingsSection>
{/each}

<style>
  .mcp-settings-row {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .mcp-settings-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: 0 0 9px;
    background: hsl(var(--muted-foreground));
  }
  .mcp-settings-dot.up {
    background: hsl(var(--st-done));
  }
  .mcp-settings-dot.down {
    background: hsl(var(--st-error));
  }
  .mcp-settings-state {
    font-size: 12.5px;
    font-weight: 500;
  }
  .mcp-settings-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 8px;
  }
  .mcp-settings-tool {
    font-size: 10.5px;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid hsl(var(--border));
    color: hsl(var(--muted-foreground));
  }
  .mcp-settings-error {
    font-size: 12px;
    color: hsl(var(--st-error));
    margin: 0 0 8px;
  }
  .repo-settings-field {
    margin-bottom: 8px;
  }
  .scope-section {
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
  }
  .scope-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .scope-title {
    font-size: 12px;
    font-weight: 500;
    color: hsl(var(--foreground));
  }
  .scope-list {
    display: flex;
    flex-direction: column;
    max-height: 180px;
    overflow-y: auto;
    margin-bottom: 8px;
    border-top: 1px solid hsl(var(--border));
    border-bottom: 1px solid hsl(var(--border));
    padding: 4px 0;
  }
</style>
