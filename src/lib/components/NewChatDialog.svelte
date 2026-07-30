<script lang="ts">
  /**
   * TASK-CIOEQ: the "New chat" panel — deliberately minimal. Unlike
   * NewAgentDialog, the only decision it asks for is which repository; picking
   * one starts a blank chat-flavoured agent immediately (see
   * stores.ts's startChatAgent).
   */
  import { chatDialogOpen, repos, settingsOpen, mobile, startChatAgent } from '../stores'
  import ResponsivePanel from './ResponsivePanel.svelte'

  function pick(repoId: string): void {
    chatDialogOpen.set(false)
    void startChatAgent(repoId)
  }
</script>

{#if $chatDialogOpen}
  <ResponsivePanel open mobile={$mobile} onClose={() => chatDialogOpen.set(false)}>
    <svelte:fragment slot="header">
      <h2>New chat</h2>
      <p>Pick a repo to drop into a blank agent in a fresh worktree — no ticket, no prompt.</p>
    </svelte:fragment>

    <div class="dlg-body">
      <div>
        <span class="lbl-f">Repository</span>
        {#if $repos.length > 0}
          <div class="ticket-pick">
            {#each $repos as r (r.id)}
              <button type="button" class="tk" on:click={() => pick(r.id)}>
                <span class="tk-t"><span class="muted">{r.org}/</span>{r.name}</span>
                <span class="badge mono">{r.base}</span>
              </button>
            {/each}
          </div>
        {:else}
          <p class="cfg-hint">
            No repositories yet. <button
              type="button"
              class="link-btn"
              on:click={() => {
                chatDialogOpen.set(false)
                settingsOpen.set(true)
              }}>Add one in Settings</button
            >.
          </p>
        {/if}
      </div>
    </div>
  </ResponsivePanel>
{/if}

<style>
  .link-btn {
    color: hsl(var(--primary));
    text-decoration: underline;
    cursor: pointer;
  }
</style>
