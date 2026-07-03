<script lang="ts">
  import {
    repos,
    registerRepo,
    removeRepoById,
    registerRepoByPath,
    registerRepoByUrl,
    settingsRepoId,
    settingsOpen,
  } from '../../stores'
  import { icons } from '../../icons'
  import { hasBackend, getRepoSettings, setRepoSettings } from '../../ipc'
  import { pushToast } from '../../toast'

  // Web mode: show a text-input for adding repos by absolute path.
  // We detect web mode by checking the explicit marker set in main.ts on the
  // WS boot path. The Electron preload never sets this marker, so isWeb is
  // false on desktop even though window.electron is also absent there.
  const isWeb =
    hasBackend && (window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb === true

  let pathInput = ''
  let pathPending = false
  let urlInput = ''
  let urlPending = false

  async function addByPath() {
    const p = pathInput.trim()
    if (!p) return
    pathPending = true
    try {
      await registerRepoByPath(p)
      pathInput = ''
    } finally {
      pathPending = false
    }
  }

  function pathKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') addByPath()
  }

  async function addByUrl() {
    const u = urlInput.trim()
    if (!u) return
    urlPending = true
    try {
      await registerRepoByUrl(u)
      urlInput = ''
    } finally {
      urlPending = false
    }
  }
  function urlKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') addByUrl()
  }

  // Per-repo settings expansion
  let expandedRepoId: string | null = null
  let installCmd = ''
  let startCmd = ''
  let settingsPending = false

  async function loadSettings(repoId: string) {
    try {
      const s = await getRepoSettings(repoId)
      installCmd = s.installCmd
      startCmd = s.startCmd
    } catch {
      installCmd = ''
      startCmd = ''
    }
  }

  function toggleExpand(repoId: string) {
    if (expandedRepoId === repoId) {
      expandedRepoId = null
    } else {
      expandedRepoId = repoId
      loadSettings(repoId)
    }
  }

  async function saveRepoSettings(repoId: string) {
    settingsPending = true
    try {
      await setRepoSettings(repoId, { installCmd: installCmd.trim(), startCmd: startCmd.trim() })
      pushToast('success', 'Saved settings')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      settingsPending = false
    }
  }

  // React to focus requests from openRepoSettings()
  $: if ($settingsOpen && $settingsRepoId) {
    if (expandedRepoId !== $settingsRepoId) {
      expandedRepoId = $settingsRepoId
      loadSettings($settingsRepoId)
    }
  }
</script>

<div class="tab-header">
  <span class="tab-title">Repositories</span>
  {#if !isWeb}
    <button class="btn btn-outline btn-sm" on:click={() => registerRepo()}>
      {@html icons.plus} Add repository
    </button>
  {/if}
</div>

<div class="path-add">
  <input
    type="text"
    class="path-input"
    placeholder="Git remote URL, e.g. https://github.com/acme/api.git"
    bind:value={urlInput}
    on:keydown={urlKeydown}
    disabled={urlPending}
  />
  <button
    class="btn btn-outline btn-sm"
    on:click={addByUrl}
    disabled={!urlInput.trim() || urlPending}
  >
    {@html icons.plus} Clone
  </button>
</div>

{#if isWeb}
  <div class="path-add">
    <input
      type="text"
      class="path-input"
      placeholder="Absolute path, e.g. /home/user/projects/my-repo"
      bind:value={pathInput}
      on:keydown={pathKeydown}
      disabled={pathPending}
    />
    <button
      class="btn btn-outline btn-sm"
      on:click={addByPath}
      disabled={!pathInput.trim() || pathPending}
    >
      {@html icons.plus} Add
    </button>
  </div>
{/if}

{#if $repos.length === 0}
  <div class="repo-empty">No repositories yet. Add one to start launching agents.</div>
{:else}
  <div class="repo-list">
    {#each $repos as r (r.id)}
      <div class="repo-row">
        <span class="mono repo-name">{r.org}/{r.name}</span>
        <span class="badge mono">{r.base}</span>
        <span class="muted repo-id mono">{r.id}</span>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          title="Repository settings"
          class:active={expandedRepoId === r.id}
          on:click={() => toggleExpand(r.id)}
        >
          {@html icons.settings}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm btn-danger"
          title="Remove repository"
          on:click={() => removeRepoById(r.id)}
        >
          {@html icons.trash}
        </button>
      </div>
      {#if expandedRepoId === r.id}
        <div class="repo-settings-panel">
          <div class="repo-settings-field">
            <label class="lbl-f" for="install-cmd-{r.id}">Install command</label>
            <input
              id="install-cmd-{r.id}"
              type="text"
              class="path-input"
              placeholder="pnpm install"
              bind:value={installCmd}
              disabled={settingsPending}
            />
          </div>
          <div class="repo-settings-field">
            <label class="lbl-f" for="start-cmd-{r.id}">Start command</label>
            <input
              id="start-cmd-{r.id}"
              type="text"
              class="path-input"
              placeholder="pnpm dev"
              bind:value={startCmd}
              disabled={settingsPending}
            />
          </div>
          <button
            class="btn btn-outline btn-sm"
            on:click={() => saveRepoSettings(r.id)}
            disabled={settingsPending}
          >
            Save
          </button>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .repo-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    overflow: hidden;
  }

  .repo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    background: hsl(var(--card));
    border-bottom: 1px solid hsl(var(--border));
    transition: background 0.12s;
  }

  .repo-row:last-child {
    border-bottom: none;
  }

  .repo-row:hover {
    background: hsl(var(--card-hover));
  }

  .repo-name {
    font-size: 13px;
    flex: 0 0 auto;
  }

  .repo-id {
    font-size: 11px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo-empty {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    padding: 32px 0;
    text-align: center;
    line-height: 1.5;
  }

  .repo-settings-panel {
    padding: 12px 16px;
    background: hsl(var(--background));
    border-bottom: 1px solid hsl(var(--border));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
