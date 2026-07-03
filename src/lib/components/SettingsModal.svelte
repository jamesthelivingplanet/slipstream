<script lang="ts">
  import { settingsOpen, settingsRepoId, mobile } from '../stores'
  import ResponsivePanel from './ResponsivePanel.svelte'
  import SettingsRepositories from './settings/SettingsRepositories.svelte'
  import SettingsIntegrations from './settings/SettingsIntegrations.svelte'
  import SettingsBehavior from './settings/SettingsBehavior.svelte'
  import SettingsNotifications from './settings/SettingsNotifications.svelte'
  import SettingsAbout from './settings/SettingsAbout.svelte'

  let activeTab = 'repositories'

  // React to focus requests from openRepoSettings()
  $: if ($settingsOpen && $settingsRepoId) {
    activeTab = 'repositories'
  }

  function closeModal() {
    settingsOpen.set(false)
    settingsRepoId.set(null)
  }
</script>

{#if $settingsOpen}
  <ResponsivePanel open mobile={$mobile} onClose={closeModal} dialogClass="settings-dialog">
    <svelte:fragment slot="header">
      <h2>Settings</h2>
    </svelte:fragment>

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
          on:click={() => (activeTab = 'integrations')}
        >
          Integrations
        </button>
        <button
          type="button"
          class="tab-item"
          class:active={activeTab === 'behavior'}
          on:click={() => (activeTab = 'behavior')}
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
          <SettingsRepositories />
        {/if}

        {#if activeTab === 'integrations'}
          <SettingsIntegrations />
        {/if}

        {#if activeTab === 'behavior'}
          <SettingsBehavior />
        {/if}

        {#if activeTab === 'notifications'}
          <SettingsNotifications />
        {/if}

        {#if activeTab === 'about'}
          <SettingsAbout />
        {/if}
      </div>
    </div>
  </ResponsivePanel>
{/if}

<style>
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
    transition: 0.14s;
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

  @media (max-width: 700px) {
    .settings-body {
      flex-direction: column;
    }
    .tab-list {
      flex-direction: row;
      width: 100%;
      flex: 0 0 auto;
      overflow-x: auto;
      border-right: none;
      border-bottom: 1px solid hsl(var(--border));
    }
    .tab-content {
      padding: 16px;
    }
  }
</style>
