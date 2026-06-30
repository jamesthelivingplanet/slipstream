<script lang="ts">
  import { settingsOpen, repos, registerRepo, removeRepoById, registerRepoByPath, settingsRepoId } from '../stores'
  import { icons } from '../icons'
  import { hasBackend, getEditorConfig, setEditorConfig, getRepoSettings, setRepoSettings } from '../ipc'
  import { pushToast } from '../toast'
  import { pushSupported, enablePush, updatePrefs, disablePush, loadPrefs } from '../push'
  import type { NotifyPrefs } from '../../../electron/shared/contract.js'

  let activeTab = 'repositories'

  const appVersion = __APP_VERSION__
  const appGitHash = __APP_GIT_HASH__

  let pushEnabled = false
  let prefs: NotifyPrefs = { needs: true, done: true, running: false }
  let pushLoading = false

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
  $: if ($settingsOpen && activeTab === 'notifications') initNotifications()

  async function initNotifications() {
    if (!isWeb || !pushSupported()) return
    try {
      const loaded = await loadPrefs()
      if (loaded) {
        pushEnabled = true
        prefs = loaded
      } else {
        pushEnabled = false
        prefs = { needs: true, done: true, running: false }
      }
    } catch {
      // ignore
    }
  }

  async function handleEnablePush() {
    pushLoading = true
    try {
      const result = await enablePush(prefs)
      if (result.ok) {
        pushEnabled = true
        pushToast('success', 'Notifications enabled')
      } else {
        const msg =
          result.reason === 'unsupported' ? 'Push notifications are not supported in this browser.' :
          result.reason === 'denied' ? 'Notification permission was denied.' :
          result.reason ?? 'Could not enable notifications.'
        pushToast('error', msg)
      }
    } finally {
      pushLoading = false
    }
  }

  async function handleDisablePush() {
    pushLoading = true
    try {
      await disablePush()
      pushEnabled = false
      pushToast('success', 'Notifications disabled')
    } catch {
      pushToast('error', 'Failed to disable notifications.')
    } finally {
      pushLoading = false
    }
  }

  async function handlePrefsChange() {
    if (!pushEnabled) return
    const ok = await updatePrefs(prefs)
    if (!ok) pushToast('error', 'Failed to update notification preferences.')
  }

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
    activeTab = 'repositories'
    if (expandedRepoId !== $settingsRepoId) {
      expandedRepoId = $settingsRepoId
      loadSettings($settingsRepoId)
    }
  }

  function closeModal() {
    settingsOpen.set(false)
    settingsRepoId.set(null)
    expandedRepoId = null
  }
</script>

{#if $settingsOpen}
  <div class="overlay" on:click={closeModal} role="presentation"></div>
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
        <button
          type="button"
          class="tab-item"
          class:active={activeTab === 'notifications'}
          on:click={() => (activeTab = 'notifications')}
        >
          Notifications
        </button>
        <button
          type="button"
          class="tab-item"
          class:active={activeTab === 'about'}
          on:click={() => (activeTab = 'about')}
        >
          About
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

        {#if activeTab === 'notifications'}
          <div class="tab-header">
            <span class="tab-title">Notifications</span>
          </div>
          {#if !isWeb}
            <p class="integration-hint muted">Push notifications are available in the installed web app (PWA). Open Slipstream in your mobile/desktop browser to enable them.</p>
          {:else if !pushSupported()}
            <p class="integration-hint muted">Push notifications are not supported in this browser.</p>
          {:else}
            <div class="notify-row">
              <span class="lbl-f" style="margin-bottom:0">Enable notifications</span>
              {#if pushEnabled}
                <button class="btn btn-outline btn-sm" on:click={handleDisablePush} disabled={pushLoading}>
                  Disable
                </button>
              {:else}
                <button class="btn btn-primary btn-sm" on:click={handleEnablePush} disabled={pushLoading}>
                  Enable
                </button>
              {/if}
            </div>
            {#if pushEnabled}
              <div>
                <span class="lbl-f">Notify me when an agent…</span>
                <label class="notify-check">
                  <input type="checkbox" bind:checked={prefs.needs} on:change={handlePrefsChange} />
                  Needs attention
                </label>
                <label class="notify-check">
                  <input type="checkbox" bind:checked={prefs.done} on:change={handlePrefsChange} />
                  Is done
                </label>
                <label class="notify-check">
                  <input type="checkbox" bind:checked={prefs.running} on:change={handlePrefsChange} />
                  Starts running
                </label>
              </div>
            {/if}
          {/if}
        {/if}

        {#if activeTab === 'about'}
          <div class="tab-header">
            <span class="tab-title">About</span>
          </div>

          <div class="about-block">
            <div class="about-logo">
              <img src="/icons/icon.svg" alt="Slipstream" class="about-glyph" />
              <div>
                <b>Slipstream</b>
                <p class="about-desc">A desktop console for running and watching many Claude Code agents at once.</p>
              </div>
            </div>

            <div class="about-links">
              <a class="about-row" href="https://gitlab.com/ajlebaron/slipstream" target="_blank" rel="noopener noreferrer">
                <span class="about-label">Repository</span>
                <span class="about-value mono">gitlab.com/ajlebaron/slipstream {@html icons.externalLink}</span>
              </a>
              <a class="about-row" href="https://gitlab.com/ajlebaron/slipstream/-/issues" target="_blank" rel="noopener noreferrer">
                <span class="about-label">File an issue</span>
                <span class="about-value mono">Report bugs &amp; request features {@html icons.externalLink}</span>
              </a>
              <a class="about-row" href="https://gitlab.com/ajlebaron/slipstream/-/merge_requests" target="_blank" rel="noopener noreferrer">
                <span class="about-label">Merge requests</span>
                <span class="about-value mono">Contribute code {@html icons.externalLink}</span>
              </a>
            </div>

            <div class="about-version">
              <span class="muted">Version</span>
              <span class="mono">{appVersion}</span>
              <span class="muted">·</span>
              <span class="mono">{appGitHash}</span>
            </div>
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

  .repo-settings-panel {
    padding: 12px 16px;
    background: hsl(var(--background));
    border-bottom: 1px solid hsl(var(--border));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .repo-settings-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .notify-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .notify-check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: hsl(var(--foreground));
    cursor: pointer;
    padding: 4px 0;
  }

  .about-block { display: flex; flex-direction: column; gap: 18px; }
  .about-logo { display: flex; gap: 14px; align-items: flex-start; }
  .about-glyph { width: 40px; height: 40px; border-radius: 10px; flex: 0 0 40px; object-fit: contain; }
  .about-logo b { font-size: 15px; font-weight: 600; }
  .about-desc { font-size: 12.5px; color: hsl(var(--muted-foreground)); margin-top: 4px; line-height: 1.5; }
  .about-links { display: flex; flex-direction: column; gap: 1px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); overflow: hidden; }
  .about-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; background: hsl(var(--card)); border-bottom: 1px solid hsl(var(--border)); transition: background .12s; text-decoration: none; color: inherit; }
  .about-row:last-child { border-bottom: none; }
  .about-row:hover { background: hsl(var(--card-hover)); }
  .about-label { font-size: 13px; font-weight: 500; }
  .about-value { font-size: 12px; color: hsl(var(--primary)); display: inline-flex; align-items: center; gap: 6px; }
  .about-version { display: flex; align-items: center; gap: 8px; font-size: 12px; padding-top: 4px; }
</style>
