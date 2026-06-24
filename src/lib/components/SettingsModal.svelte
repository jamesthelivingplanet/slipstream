<script lang="ts">
  import { settingsOpen, repos, registerRepo, removeRepoById, registerRepoByPath } from '../stores'
  import { icons } from '../icons'
  import { hasBackend, getEditorConfig, setEditorConfig } from '../ipc'
  import { pushToast } from '../toast'

  let activeTab = 'repositories'

  let linearKey = ''
  let linearPending = false

  let editorCommand = ''
  let mobileEditorCommand = ''
  let editorPending = false

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

  async function loadEditorConfig() {
    if (!hasBackend) return
    try {
      const cfg = await getEditorConfig()
      editorCommand = cfg.command
      mobileEditorCommand = cfg.mobileCommand
    } catch { /* ignore */ }
  }
  async function saveEditorConfig() {
    if (!hasBackend) return
    editorPending = true
    try {
      await setEditorConfig({ command: editorCommand.trim(), mobileCommand: mobileEditorCommand.trim() })
      pushToast('success', 'Editor settings saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save editor settings')
    } finally {
      editorPending = false
    }
  }

  $: if ($settingsOpen && activeTab === 'integrations') loadLinearKey()
  $: if ($settingsOpen && activeTab === 'behavior') loadEditorConfig()

  // Web mode: show a text-input for adding repos by absolute path.
  // We detect web mode by checking the explicit marker set in main.ts on the
  // WS boot path. The Electron preload never sets this marker, so isWeb is
  // false on desktop even though window.electron is also absent there.
  const isWeb = hasBackend && (window as unknown as { __slipstreamWeb?: boolean }).__slipstreamWeb === true

  let pathInput = ''
  let pathPending = false

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
</script>

{#if $settingsOpen}
  <div class="overlay" on:click={() => settingsOpen.set(false)} role="presentation"></div>
  <div class="dialog settings-dialog">
    <div class="dlg-head">
      <h2>Settings</h2>
    </div>

    <div class="settings-body">
      <nav class="tab-list">
        <button
          type="button"
          class="tab-item"
          class:active={activeTab === 'repositories'}
          on:click={() => (activeTab = 'repositories')}
        >
          Repositories
        </button>
        <button
          type="button"
          class="tab-item"
          class:active={activeTab === 'integrations'}
          on:click={() => { activeTab = 'integrations'; loadLinearKey() }}
        >
          Integrations
        </button>
        <button
          type="button"
          class="tab-item"
          class:active={activeTab === 'behavior'}
          on:click={() => { activeTab = 'behavior'; loadEditorConfig() }}
        >
          Behavior
        </button>
      </nav>

      <div class="tab-content">
        {#if activeTab === 'repositories'}
          <div class="tab-header">
            <span class="tab-title">Repositories</span>
            {#if !isWeb}
              <button class="btn btn-outline btn-sm" on:click={() => registerRepo()}>
                {@html icons.plus} Add repository
              </button>
            {/if}
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
            <div class="repo-empty">
              No repositories yet. Add one to start launching agents.
            </div>
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
              {/each}
            </div>
          {/if}
        {/if}

        {#if activeTab === 'integrations'}
          <div class="tab-header">
            <span class="tab-title">Integrations</span>
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
        {/if}

        {#if activeTab === 'behavior'}
          <div class="tab-header">
            <span class="tab-title">Behavior</span>
          </div>
          <div>
            <span class="lbl-f">Editor command</span>
            <p class="integration-hint">Command run to open a worktree in your editor, e.g. <code>code</code> (VS Code) or <code>zed</code> (Zed). The worktree path is appended as an argument.</p>
            <input
              type="text"
              class="path-input"
              placeholder="code"
              bind:value={editorCommand}
              disabled={editorPending || !hasBackend}
            />
          </div>
          <div>
            <span class="lbl-f">Mobile editor command (optional)</span>
            <p class="integration-hint">Used instead when opening from the mobile layout. Leave blank to use the editor command above. Tip: a web-accessible editor such as <code>code serve-web</code> works well here.</p>
            <div class="path-add">
              <input
                type="text"
                class="path-input"
                placeholder="code serve-web"
                bind:value={mobileEditorCommand}
                disabled={editorPending || !hasBackend}
              />
              <button
                class="btn btn-outline btn-sm"
                on:click={saveEditorConfig}
                disabled={editorPending || !hasBackend}
              >
                Save
              </button>
            </div>
            {#if !hasBackend}
              <p class="integration-hint muted">Backend not available in browser-only mode.</p>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-dialog {
    width: 680px;
  }

  .settings-body {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 360px;
  }

  .tab-list {
    width: 148px;
    flex: 0 0 148px;
    border-right: 1px solid hsl(var(--border));
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tab-item {
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border-radius: calc(var(--radius) - 3px);
    font-size: 13px;
    font-weight: 500;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
    transition: .14s;
  }

  .tab-item:hover {
    background: hsl(var(--accent-bg));
    color: hsl(var(--foreground));
  }

  .tab-item.active {
    background: hsl(var(--accent-bg));
    color: hsl(var(--foreground));
  }

  .tab-content {
    flex: 1;
    padding: 18px 22px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .tab-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .tab-title {
    font-size: 13.5px;
    font-weight: 600;
  }

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
    transition: background .12s;
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

  .path-add {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .path-input {
    flex: 1;
    height: 34px;
    background: hsl(var(--background));
    border: 1px solid hsl(var(--input));
    border-radius: var(--radius);
    color: inherit;
    font-family: 'Geist Mono', monospace;
    font-size: 12px;
    padding: 0 10px;
  }

  .path-input:focus {
    outline: none;
    border-color: hsl(var(--ring));
    box-shadow: 0 0 0 3px hsl(var(--ring) / 0.12);
  }

  .lbl-f {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: hsl(var(--muted-foreground));
    margin-bottom: 6px;
  }

  .integration-hint {
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    margin: 0 0 8px;
    line-height: 1.5;
  }
</style>
