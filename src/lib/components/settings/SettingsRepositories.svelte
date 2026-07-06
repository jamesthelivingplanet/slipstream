<script lang="ts">
  import { tick, onDestroy } from 'svelte'
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
  let showPathEntry = false

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

  // Per-repo install/start commands — always visible, one entry per repo.
  let cmds: Record<string, { installCmd: string; startCmd: string }> = {}
  let pending: Record<string, boolean> = {}

  async function loadSettings(repoId: string) {
    try {
      const s = await getRepoSettings(repoId)
      cmds = { ...cmds, [repoId]: { installCmd: s.installCmd, startCmd: s.startCmd } }
    } catch {
      cmds = { ...cmds, [repoId]: { installCmd: '', startCmd: '' } }
    }
  }

  // Hydrate commands for any repo we haven't loaded yet (also covers newly
  // added repos). Seed synchronously so inputs never bind to undefined.
  // Plain subscription (not a reactive statement) because this updates `cmds`.
  const unsubRepos = repos.subscribe((rs) => {
    for (const r of rs) {
      if (!(r.id in cmds)) {
        cmds = { ...cmds, [r.id]: { installCmd: '', startCmd: '' } }
        loadSettings(r.id)
      }
    }
  })
  onDestroy(unsubRepos)

  async function saveRepoSettings(repoId: string) {
    const c = cmds[repoId]
    if (!c) return
    pending = { ...pending, [repoId]: true }
    try {
      await setRepoSettings(repoId, {
        installCmd: c.installCmd.trim(),
        startCmd: c.startCmd.trim(),
      })
      pushToast('success', 'Saved settings')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      pending = { ...pending, [repoId]: false }
    }
  }

  // React to focus requests from openRepoSettings(): the fields are always
  // visible now, so just focus that repo's start-command input.
  $: if ($settingsOpen && $settingsRepoId) {
    const id = $settingsRepoId
    tick().then(() => document.getElementById(`start-cmd-${id}`)?.focus())
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
  <div class="cfg-hint">
    Clone by remote URL — recommended. The repo is cloned into the managed location on the server.
  </div>
{/if}

{#if isWeb}
  {#if !showPathEntry}
    <button type="button" class="path-toggle" on:click={() => (showPathEntry = true)}>
      Add by server path instead
    </button>
  {:else}
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
          class="btn btn-ghost btn-icon btn-sm btn-danger"
          title="Remove repository"
          on:click={() => removeRepoById(r.id)}
        >
          {@html icons.trash}
        </button>
      </div>
      {#if cmds[r.id]}
        <div class="repo-settings-panel">
          <div class="repo-settings-field">
            <label class="lbl-f" for="install-cmd-{r.id}">Install command</label>
            <input
              id="install-cmd-{r.id}"
              type="text"
              class="path-input"
              placeholder="pnpm install"
              bind:value={cmds[r.id].installCmd}
              disabled={pending[r.id]}
            />
          </div>
          <div class="repo-settings-field">
            <label class="lbl-f" for="start-cmd-{r.id}">Start command</label>
            <input
              id="start-cmd-{r.id}"
              type="text"
              class="path-input"
              placeholder="pnpm dev"
              bind:value={cmds[r.id].startCmd}
              disabled={pending[r.id]}
            />
          </div>
          <button
            class="btn btn-outline btn-sm"
            on:click={() => saveRepoSettings(r.id)}
            disabled={pending[r.id]}
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

  .path-toggle {
    background: none;
    border: none;
    padding: 0;
    margin: 6px 0 4px;
    font-size: 12.5px;
    color: hsl(var(--muted-foreground));
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .path-toggle:hover {
    color: hsl(var(--foreground));
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
