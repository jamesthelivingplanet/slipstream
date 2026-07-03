<script lang="ts">
  import { onMount } from 'svelte'
  import { mcpStatus, mcpChecking, refreshMcpStatus } from '../../stores'
  import { hasBackend, getGitToken, setGitToken } from '../../ipc'
  import { pushToast } from '../../toast'

  let linearKey = ''
  let linearPending = false

  let githubToken = ''
  let githubPending = false
  let gitlabToken = ''
  let gitlabPending = false

  async function loadLinearKey() {
    if (!hasBackend) return
    try {
      const stored = await window.slipstream.getLinearKey()
      if (stored) linearKey = stored
    } catch {
      // ignore
    }
  }

  async function saveLinearKey() {
    if (!hasBackend) return
    linearPending = true
    try {
      await window.slipstream.setLinearKey(linearKey.trim())
      pushToast('success', 'Linear API key saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save key')
    } finally {
      linearPending = false
    }
  }

  async function loadGithubToken() {
    if (!hasBackend) return
    try {
      const stored = await getGitToken('github')
      if (stored) githubToken = stored
    } catch {
      // ignore
    }
  }

  async function saveGithubToken() {
    if (!hasBackend) return
    githubPending = true
    try {
      await setGitToken('github', githubToken.trim())
      pushToast('success', 'GitHub token saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      githubPending = false
    }
  }

  async function loadGitlabToken() {
    if (!hasBackend) return
    try {
      const stored = await getGitToken('gitlab')
      if (stored) gitlabToken = stored
    } catch {
      // ignore
    }
  }

  async function saveGitlabToken() {
    if (!hasBackend) return
    gitlabPending = true
    try {
      await setGitToken('gitlab', gitlabToken.trim())
      pushToast('success', 'GitLab token saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      gitlabPending = false
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
    loadLinearKey()
    loadGithubToken()
    loadGitlabToken()
    refreshMcpStatus()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Integrations</span>
</div>
<div>
  <span class="lbl-f">MCP server</span>
  <p class="integration-hint">
    Lets a finished agent push its branch, open the PR, and report status back to Slipstream.
  </p>
  <div class="mcp-settings-row">
    <span
      class="mcp-settings-dot"
      class:up={$mcpStatus?.up}
      class:down={$mcpStatus && !$mcpStatus.up}
    ></span>
    <span class="mcp-settings-state"
      >{$mcpStatus === null ? 'Checking' : $mcpStatus.up ? 'Up' : 'Unreachable'}</span
    >
    {#if $mcpStatus?.serverName || $mcpStatus?.protocolVersion}
      <span class="mono muted mcp-settings-meta">
        {$mcpStatus?.serverName ?? ''}{$mcpStatus?.serverName && $mcpStatus?.protocolVersion
          ? ' · '
          : ''}{$mcpStatus?.protocolVersion ?? ''}
      </span>
    {/if}
  </div>
  {#if $mcpStatus?.tools?.length}
    <div class="mcp-settings-tools">
      {#each $mcpStatus.tools as tool (tool)}
        <span class="mcp-settings-tool mono">{tool}</span>
      {/each}
    </div>
  {/if}
  {#if $mcpStatus}
    <p class="integration-hint muted">
      Checked {mcpRelTime($mcpStatus.checkedAt)} ago{#if $mcpStatus.lastActivityAt}
        · Last used {mcpRelTime($mcpStatus.lastActivityAt)} ago{:else}
        · No agent has used it yet{/if}
    </p>
  {/if}
  {#if $mcpStatus?.error}
    <p class="mcp-settings-error">{$mcpStatus.error}</p>
  {/if}
  <button
    class="btn btn-outline btn-sm"
    on:click={() => refreshMcpStatus()}
    disabled={$mcpChecking}
  >
    {$mcpChecking ? 'Checking…' : 'Test connection'}
  </button>
</div>
<div>
  <span class="lbl-f">Linear API Key</span>
  <p class="integration-hint">Personal API key from Linear → Settings → API → Personal API keys.</p>
  <div class="path-add">
    <input
      type="password"
      class="path-input"
      placeholder="lin_api_••••••••••••••••••••••••••••••••"
      bind:value={linearKey}
      disabled={linearPending || !hasBackend}
    />
    <button
      class="btn btn-outline btn-sm"
      on:click={saveLinearKey}
      disabled={!linearKey.trim() || linearPending || !hasBackend}
    >
      Save
    </button>
  </div>
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</div>
<div>
  <span class="lbl-f">GitHub Token</span>
  <p class="integration-hint">Personal access token with repo scope.</p>
  <div class="path-add">
    <input
      type="password"
      class="path-input"
      placeholder="ghp_••••••••••••••••••••••••••••••••"
      bind:value={githubToken}
      disabled={githubPending || !hasBackend}
    />
    <button
      class="btn btn-outline btn-sm"
      on:click={saveGithubToken}
      disabled={!githubToken.trim() || githubPending || !hasBackend}
    >
      Save
    </button>
  </div>
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</div>
<div>
  <span class="lbl-f">GitLab Token</span>
  <p class="integration-hint">Personal access token with repo scope.</p>
  <div class="path-add">
    <input
      type="password"
      class="path-input"
      placeholder="glpat-••••••••••••••••••••••••••••••••"
      bind:value={gitlabToken}
      disabled={gitlabPending || !hasBackend}
    />
    <button
      class="btn btn-outline btn-sm"
      on:click={saveGitlabToken}
      disabled={!gitlabToken.trim() || gitlabPending || !hasBackend}
    >
      Save
    </button>
  </div>
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</div>

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
  .mcp-settings-meta {
    font-size: 11px;
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
</style>
