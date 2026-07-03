<script lang="ts">
  import {
    dialogOpen,
    tickets,
    createAgentFromTicket,
    createBlankAgent,
    startAgent,
    refreshTickets,
    repos,
    repoById,
    settingsOpen,
    mobile,
  } from '../stores'
  import ResponsivePanel from './ResponsivePanel.svelte'
  import { branchFor } from '../branch'
  import { icons } from '../icons'
  import { checkAgentCli } from '../ipc'
  import type { Ticket, BackendKind } from '../types'
  import type { AgentCliCheck } from '../../../electron/shared/contract'

  let picked: Ticket | null = null
  let title = ''
  let prompt = ''
  let repoChoice: string | null = null
  let menuOpen = false
  let draftTid = ''
  let wasOpen = false
  let loadingTickets = false
  let agentKind: BackendKind = 'claude-code'
  let cliCheck: AgentCliCheck | null = null

  function runCliCheck(kind: BackendKind) {
    cliCheck = null
    checkAgentCli(kind).then((res) => {
      if (kind === agentKind) cliCheck = res
    })
  }

  function selectAgentKind(kind: BackendKind) {
    agentKind = kind
    runCliCheck(kind)
  }

  $: cliMissing = cliCheck !== null && cliCheck.found === false

  $: chosen = repoChoice ? repoById(repoChoice) : undefined
  $: previewTid = picked ? picked.tid : draftTid
  $: branch = previewTid ? branchFor(previewTid, title.trim() || 'task') : ''

  $: if ($dialogOpen && !wasOpen) {
    picked = null
    title = ''
    prompt = ''
    repoChoice = null
    menuOpen = false
    draftTid = `TASK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    wasOpen = true
    runCliCheck(agentKind)
    // refresh tickets when dialog opens
    loadingTickets = true
    refreshTickets().finally(() => {
      loadingTickets = false
    })
  }
  $: if (!$dialogOpen) wasOpen = false

  function pick(t: Ticket) {
    picked = t
    title = t.title
    prompt = `Begin implementing ${t.tid}.`
    // Pre-select the ticket's suggested repo when it matches a registered repo.
    repoChoice = t.repo || null
    menuOpen = false
  }

  async function start() {
    if (!title.trim() || !repoChoice) return
    const id = picked
      ? createAgentFromTicket(picked, prompt, agentKind)
      : createBlankAgent(title.trim(), prompt, draftTid, agentKind)
    await startAgent(id, repoChoice as string, prompt, agentKind)
  }

  function onWindowClick(e: MouseEvent) {
    if (menuOpen && !(e.target as HTMLElement).closest('#dlgRepoSel')) menuOpen = false
  }
</script>

<svelte:window on:click={onWindowClick} />

{#if $dialogOpen}
  <ResponsivePanel open mobile={$mobile} onClose={() => dialogOpen.set(false)}>
    <svelte:fragment slot="header">
      <h2>New agent</h2>
      <p>Pick a ticket or start blank, choose a repo, and start it in one go.</p>
    </svelte:fragment>

    <div class="dlg-body">
      <div>
        <label class="lbl-f" for="dTitle">Title</label>
        <input
          id="dTitle"
          type="text"
          bind:value={title}
          placeholder="What should this agent work on?"
        />
      </div>

      <div>
        <span class="lbl-f">Agent type</span>
        <div class="agent-kind-toggle">
          <button
            type="button"
            class="toggle-opt"
            class:active={agentKind === 'claude-code'}
            on:click={() => selectAgentKind('claude-code')}
          >
            Claude Code
          </button>
          <button
            type="button"
            class="toggle-opt"
            class:active={agentKind === 'opencode'}
            on:click={() => selectAgentKind('opencode')}
          >
            OpenCode
          </button>
          <button
            type="button"
            class="toggle-opt"
            class:active={agentKind === 'pi'}
            on:click={() => selectAgentKind('pi')}
          >
            Pi
          </button>
        </div>
        {#if cliMissing}
          <p class="cfg-hint cli-warn">
            <b>{cliCheck?.bin}</b> was not found on PATH. Install it and make sure it's on the daemon's
            PATH before starting an agent.
          </p>
        {/if}
      </div>

      {#if loadingTickets || $tickets.length > 0}
        <div>
          <span class="lbl-f">From ticket</span>
          {#if loadingTickets}
            <p class="muted" style="font-size: 0.85em;">Loading tickets…</p>
          {:else}
            <div class="ticket-pick">
              {#each $tickets as t (t.tid)}
                <button
                  type="button"
                  class="tk"
                  class:sel={picked?.tid === t.tid}
                  on:click={() => pick(t)}
                >
                  <span class="badge {t.src}" style="border:none;padding:1px 6px">{t.src}</span>
                  <span class="tk-id">{t.tid}</span>
                  <span class="tk-t">{t.title}</span>
                  <span class="check">{@html icons.check}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div>
        <label class="lbl-f" for="dPrompt">Kickoff prompt</label>
        <textarea id="dPrompt" bind:value={prompt} placeholder="Describe the task for this agent…"
        ></textarea>
        <p class="cfg-hint">
          Full ticket details are sent to the agent automatically as context. This is just the
          opening message you can tweak.
        </p>
      </div>

      <div>
        <span class="lbl-f">Repository</span>
        {#if $repos.length > 0}
          <div class="select" id="dlgRepoSel">
            <button
              class="sel-trigger"
              type="button"
              on:click|stopPropagation={() => (menuOpen = !menuOpen)}
            >
              {#if chosen}
                <span><span class="muted">{chosen.org}/</span>{chosen.name}</span>
              {:else}
                <span class="muted">Select a repository</span>
              {/if}
              <span class="chev">{@html icons.chevronDown}</span>
            </button>
            {#if menuOpen}
              <div class="sel-menu">
                {#each $repos as r (r.id)}
                  <button
                    type="button"
                    class="opt"
                    class:sel={repoChoice === r.id}
                    on:click|stopPropagation={() => {
                      repoChoice = r.id
                      menuOpen = false
                    }}
                  >
                    <span><span class="muted">{r.org}/</span>{r.name}</span>
                    <span class="badge mono" style="margin-left:8px">{r.base}</span>
                    <span class="check">{@html icons.check}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
          <p class="cfg-hint">
            A fresh worktree is branched from this repo's base branch, and claude starts inside it.
          </p>
        {:else}
          <p class="cfg-hint">
            No repositories yet. <button
              type="button"
              class="link-btn"
              on:click={() => {
                dialogOpen.set(false)
                settingsOpen.set(true)
              }}>Add one in Settings</button
            >.
          </p>
        {/if}
      </div>

      {#if chosen}
        <div class="derive">
          <div class="drow">
            <span class="k">Base branch</span><span class="v muted">{chosen.base}</span>
          </div>
          <div class="drow">
            <span class="k">New branch</span><span class="v"><b>{branch}</b></span>
          </div>
          <div class="drow">
            <span class="k">Worktree</span><span class="v muted"
              >{`.worktrees/${chosen.org}-${chosen.name}/${branch}`}</span
            >
          </div>
        </div>
      {/if}
    </div>

    <svelte:fragment slot="footer">
      <button class="btn btn-ghost" on:click={() => dialogOpen.set(false)}>Cancel</button>
      <button
        class="btn btn-primary"
        disabled={!title.trim() || !repoChoice || cliMissing}
        on:click={start}>{@html icons.play} Start agent</button
      >
    </svelte:fragment>
  </ResponsivePanel>
{/if}

<style>
  .link-btn {
    color: hsl(var(--primary));
    text-decoration: underline;
    cursor: pointer;
  }

  .cli-warn {
    margin-top: 6px;
    padding: 8px 10px;
    border-radius: var(--radius);
    border: 1px solid hsl(var(--st-needs) / 0.4);
    background: hsl(var(--st-needs) / 0.1);
    color: hsl(var(--st-needs));
  }
</style>
