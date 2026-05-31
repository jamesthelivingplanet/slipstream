<script lang="ts">
  import { settingsOpen, repos, registerRepo, removeRepoById } from '../stores'
  import { icons } from '../icons'

  let activeTab = 'repositories'
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
      </nav>

      <div class="tab-content">
        {#if activeTab === 'repositories'}
          <div class="tab-header">
            <span class="tab-title">Repositories</span>
            <button class="btn btn-outline btn-sm" on:click={() => registerRepo()}>
              {@html icons.plus} Add repository
            </button>
          </div>

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
</style>
