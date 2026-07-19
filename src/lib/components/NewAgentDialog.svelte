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
    ticketsLoading,
    ticketsTotalCount,
    ticketsPage,
    ticketsPageSize,
    ticketsHasMore,
    ticketsQuery,
    setTicketsQuery,
    loadMoreTickets,
  } from '../stores'
  import ResponsivePanel from './ResponsivePanel.svelte'
  import AgentSelector from './AgentSelector.svelte'
  import { branchFor } from '../branch'
  import { icons } from '../icons'
  import { agentOption } from '../agents'
  import {
    checkAgentCli,
    listPromptTemplates,
    savePromptTemplate,
    deletePromptTemplate,
  } from '../ipc'
  import { pushToast } from '../toast'
  import type { Ticket, BackendKind } from '../types'
  import type { AgentCliCheck, PromptTemplateDTO } from '../../../electron/shared/contract'
  import { floatingAnchor } from '../floating'
  import NullielLoader from './NullielLoader.svelte'

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
  let templates: PromptTemplateDTO[] = []
  let tplFormOpen = false
  let tplName = ''
  let tplSaving = false

  function loadTemplates(repoId: string) {
    listPromptTemplates(repoId)
      .then((ts) => {
        // Guard against a stale response after the user switched repos.
        if (repoChoice === repoId) templates = ts
      })
      .catch(() => {
        templates = []
      })
  }

  // Explicit (not reactive) so template loading happens exactly when the
  // chosen repo changes — every repoChoice write goes through here.
  function selectRepo(id: string | null) {
    repoChoice = id
    templates = []
    tplFormOpen = false
    tplName = ''
    if (id) loadTemplates(id)
  }

  function applyTemplate(t: PromptTemplateDTO) {
    prompt = t.body
  }

  async function removeTemplate(t: PromptTemplateDTO) {
    try {
      await deletePromptTemplate(t.id)
      templates = templates.filter((x) => x.id !== t.id)
      pushToast('success', `Deleted template "${t.name}"`)
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to delete template')
    }
  }

  async function saveTemplate() {
    if (!repoChoice || !tplName.trim() || !prompt.trim()) return
    tplSaving = true
    try {
      const dto = await savePromptTemplate({ repoId: repoChoice, name: tplName, body: prompt })
      templates = [...templates, dto]
      tplFormOpen = false
      tplName = ''
      pushToast('success', `Saved template "${dto.name}"`)
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save template')
    } finally {
      tplSaving = false
    }
  }

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

  // Tickets pagination reactive state
  $: ticketsLoadingState = $ticketsLoading
  $: ticketsTotalCountState = $ticketsTotalCount
  $: ticketsPageState = $ticketsPage
  $: ticketsPageSizeState = $ticketsPageSize
  $: ticketsHasMoreState = $ticketsHasMore
  $: ticketsQueryState = $ticketsQuery

  function handleTicketsSearch(query: string): void {
    setTicketsQuery(query)
  }

  async function handleLoadMoreTickets(): Promise<void> {
    await loadMoreTickets()
  }

  $: if ($dialogOpen && !wasOpen) {
    picked = null
    title = ''
    prompt = ''
    repoChoice = null
    menuOpen = false
    draftTid = `TASK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    templates = []
    tplFormOpen = false
    tplName = ''
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
    selectRepo(t.repo || null)
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
        <AgentSelector
          label="Agent type"
          value={agentKind}
          on:select={(e) => selectAgentKind(e.detail)}
        />
        <p class="cfg-hint">{agentOption(agentKind).description}</p>
        {#if cliMissing}
          <p class="cfg-hint cli-warn">
            <b>{cliCheck?.bin}</b> was not found on PATH. Install it and make sure it's on the daemon's
            PATH before starting an agent.
          </p>
        {/if}
      </div>

      {#if ticketsLoadingState || $tickets.length > 0}
        <div>
          <div class="ticket-section-header">
            <span class="lbl-f">From ticket</span>
            <div class="tickets-search">
              <input
                type="search"
                placeholder="Search tickets…"
                bind:value={ticketsQueryState}
                on:input={() => handleTicketsSearch(ticketsQueryState)}
                class="search-input"
                aria-label="Search tickets"
              />
            </div>
          </div>
          {#if ticketsLoadingState}
            <div class="tickets-loading">
              <NullielLoader size={32} caption="Loading tickets" />
            </div>
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
            {#if ticketsHasMoreState}
              <div class="tickets-load-more">
                <button
                  class="btn btn-outline btn-sm"
                  on:click={handleLoadMoreTickets}
                  disabled={ticketsLoadingState}
                >
                  {ticketsLoadingState ? 'Loading…' : `Load more (${$tickets.length} of {ticketsTotalCountState})`}
                </button>
              </div>
            {/if}
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

      {#if repoChoice && (templates.length > 0 || prompt.trim())}
        <div>
          <span class="lbl-f">Prompt templates</span>
          {#if templates.length > 0}
            <div class="tpl-row">
              {#each templates as t (t.id)}
                <span class="tpl-chip">
                  <button
                    type="button"
                    class="tpl-use"
                    title={t.body}
                    on:click={() => applyTemplate(t)}>{t.name}</button
                  >
                  <button
                    type="button"
                    class="tpl-del"
                    aria-label={`Delete template ${t.name}`}
                    on:click|stopPropagation={() => removeTemplate(t)}>×</button
                  >
                </span>
              {/each}
            </div>
          {/if}
          {#if prompt.trim()}
            {#if tplFormOpen}
              <div class="tpl-form">
                <input
                  type="text"
                  placeholder="Template name"
                  bind:value={tplName}
                  on:keydown={(e) => e.key === 'Enter' && saveTemplate()}
                />
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  disabled={!tplName.trim() || tplSaving}
                  on:click={saveTemplate}>Save</button
                >
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  on:click={() => {
                    tplFormOpen = false
                    tplName = ''
                  }}>Cancel</button
                >
              </div>
            {:else}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                on:click={() => (tplFormOpen = true)}>Save as template</button
              >
            {/if}
          {/if}
          <p class="cfg-hint">Templates are saved per repository and reusable across agents.</p>
        </div>
      {/if}

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
              <div class="sel-menu" use:floatingAnchor>
                {#each $repos as r (r.id)}
                  <button
                    type="button"
                    class="opt"
                    class:sel={repoChoice === r.id}
                    on:click|stopPropagation={() => {
                      selectRepo(r.id)
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

  .tpl-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .tpl-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid hsl(var(--border));
    border-radius: 6px;
    overflow: hidden;
  }
  .tpl-use {
    padding: 3px 8px;
    font-size: 12px;
    cursor: pointer;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tpl-use:hover {
    background: hsl(var(--accent-bg));
  }
  .tpl-del {
    padding: 3px 7px;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    border-left: 1px solid hsl(var(--border));
    cursor: pointer;
  }
  .tpl-del:hover {
    background: hsl(var(--accent-bg));
    color: hsl(var(--foreground));
  }
  .tpl-form {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tpl-form input {
    flex: 1;
    min-width: 0;
  }
</style>
