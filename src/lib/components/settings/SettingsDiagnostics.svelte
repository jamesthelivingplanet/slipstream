<script lang="ts">
  import { onMount } from 'svelte'
  import { hasBackend } from '../../ipc'
  import SettingsSection from './SettingsSection.svelte'
  import {
    diagnostics,
    diagChecking,
    refreshDiagnostics,
    cliStatus,
    cliChecking,
    refreshCliStatus,
  } from '../../stores'

  const appVersion = __APP_VERSION__
  const appGitHash = __APP_GIT_HASH__

  const daemonReused =
    typeof window === 'undefined' || !window.__slipstreamDaemon
      ? 'unknown'
      : window.__slipstreamDaemon.reused
        ? 'reused'
        : 'spawned'

  function relTime(ms: number): string {
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

  function refreshAll() {
    refreshDiagnostics()
    refreshCliStatus()
  }

  onMount(() => {
    if (!hasBackend) return
    refreshDiagnostics()
    refreshCliStatus()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Diagnostics</span>
  <button
    class="btn btn-outline btn-sm"
    on:click={refreshAll}
    disabled={$diagChecking}
    style="margin-left: auto"
  >
    {$diagChecking ? 'Refreshing…' : 'Refresh'}
  </button>
</div>

{#if !hasBackend}
  <p class="integration-hint muted">Backend not available in browser-only mode.</p>
{/if}

<SettingsSection title="Versions">
  <div class="diag-section">
    <div class="diag-grid">
      <span class="diag-key muted">App</span>
      <span class="mono">{appVersion} · {appGitHash}</span>
      <span class="diag-key muted">Daemon</span>
      <span class="mono"
        >{$diagnostics?.versions?.app ?? '—'} · {$diagnostics?.versions?.gitSha ?? '—'}</span
      >
      <span class="diag-key muted">DB schema</span>
      <span class="mono">{$diagnostics?.versions?.schema ?? '—'}</span>
      <span class="diag-key muted">Electron</span>
      <span class="mono">{$diagnostics?.versions?.electron ?? '—'}</span>
      <span class="diag-key muted">Node</span>
      <span class="mono">{$diagnostics?.versions?.node ?? '—'}</span>
      <span class="diag-key muted">V8</span>
      <span class="mono">{$diagnostics?.versions?.v8 ?? '—'}</span>
      <span class="diag-key muted">Chrome</span>
      <span class="mono">{$diagnostics?.versions?.chrome ?? '—'}</span>
    </div>
  </div>
</SettingsSection>

<SettingsSection title="Daemon">
  <div class="diag-section">
    <div class="diag-grid">
      <span class="diag-key muted">WS URL</span>
      <span class="mono">{$diagnostics?.daemon?.wsUrl ?? '—'}</span>
      <span class="diag-key muted">HTTP base</span>
      <span class="mono">{$diagnostics?.daemon?.httpBase ?? '—'}</span>
      <span class="diag-key muted">Port</span>
      <span class="mono">{$diagnostics?.daemon?.port ?? '—'}</span>
      <span class="diag-key muted">PID</span>
      <span class="mono">{$diagnostics?.daemon?.pid ?? '—'}</span>
      <span class="diag-key muted">Mode</span>
      <span class="mono">{$diagnostics?.daemon?.mode ?? '—'}</span>
      <span class="diag-key muted">Startup</span>
      <span class="mono">{daemonReused}</span>
      <span class="diag-key muted">Data dir</span>
      <span class="mono">{$diagnostics?.daemon?.dataDir ?? '—'}</span>
      <span class="diag-key muted">DB path</span>
      <span class="mono">{$diagnostics?.daemon?.dbPath ?? '—'}</span>
    </div>
  </div>
</SettingsSection>

<SettingsSection title="Repositories">
  <div class="diag-section">
    {#if $diagnostics?.repos?.length}
      <div class="diag-repos">
        {#each $diagnostics.repos as repo (repo.id)}
          <div class="diag-repo">
            <div class="diag-repo-head">
              <span class="diag-repo-name">{repo.org}/{repo.name}</span>
              <span class="mono muted diag-repo-id">{repo.id}</span>
            </div>
            <div class="mono muted diag-repo-path">{repo.path}</div>
            <div class="diag-badges">
              <span class="diag-badge" class:ok={repo.exists} class:bad={!repo.exists}>
                <span class="diag-dot" class:up={repo.exists} class:down={!repo.exists}></span>
                exists: {repo.exists ? 'yes' : 'no'}
              </span>
              <span class="diag-badge" class:ok={repo.isWorktree} class:bad={!repo.isWorktree}>
                <span class="diag-dot" class:up={repo.isWorktree} class:down={!repo.isWorktree}
                ></span>
                worktree: {repo.isWorktree ? 'yes' : 'no'}
              </span>
              <span
                class="diag-badge"
                class:ok={repo.remoteMatches}
                class:bad={!repo.remoteMatches}
              >
                <span
                  class="diag-dot"
                  class:up={repo.remoteMatches}
                  class:down={!repo.remoteMatches}
                ></span>
                remote: {repo.remoteMatches ? 'matched' : 'mismatch'}
              </span>
            </div>
            {#if !repo.remoteMatches && repo.configuredRemote && repo.actualRemote}
              <div class="diag-remote-detail mono muted">
                configured: {repo.configuredRemote}<br />
                actual: {repo.actualRemote}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <p class="integration-hint muted">No repositories registered.</p>
    {/if}
  </div>
</SettingsSection>

<SettingsSection title="CLI self-test">
  <div class="diag-section">
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
        Checked {relTime($cliStatus.checkedAt)} ago{#if $cliStatus.lastActivityAt}
          · Last used {relTime($cliStatus.lastActivityAt)} ago{:else}
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
  </div>
</SettingsSection>

<style>
  .tab-header {
    display: flex;
    align-items: center;
  }
  .diag-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .diag-grid {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 4px 10px;
    font-size: 12px;
  }
  .diag-key {
    font-size: 11px;
  }
  .diag-repos {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .diag-repo {
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    padding: 9px 11px;
    background: hsl(var(--card));
  }
  .diag-repo-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .diag-repo-name {
    font-size: 13px;
    font-weight: 500;
  }
  .diag-repo-id {
    font-size: 11px;
  }
  .diag-repo-path {
    font-size: 11px;
    word-break: break-all;
    margin-top: 2px;
  }
  .diag-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .diag-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 6px;
    border: 1px solid hsl(var(--border));
    color: hsl(var(--muted-foreground));
  }
  .diag-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: hsl(var(--muted-foreground));
    flex: 0 0 7px;
  }
  .diag-dot.up {
    background: hsl(var(--st-done));
  }
  .diag-dot.down {
    background: hsl(var(--st-error));
  }
  .diag-remote-detail {
    font-size: 11px;
    margin-top: 6px;
    word-break: break-all;
    line-height: 1.5;
  }

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
    font-size: 13px;
    font-weight: 500;
  }
  .mcp-settings-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 8px;
  }
  .mcp-settings-tool {
    font-size: 11px;
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
</style>
