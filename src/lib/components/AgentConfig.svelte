<script lang="ts">
  import { onMount } from 'svelte'
  import { repos, repoById, startAgent, discardDraft, updateDraftPrompt } from '../stores'
  import { branchFor } from '../branch'
  import AgentSelector from './AgentSelector.svelte'
  import { floatingAnchor } from '../floating'
  import { icons } from '../icons'
  import { agentOption } from '../agents'
  import { getAgentArgs } from '../ipc'
  import type { Session, BackendKind } from '../types'

  export let session: Session

  let prompt = ''
  let repoChoice: string | null = null
  let menuOpen = false
  let lastId: string | undefined = ''

  let agentKind: BackendKind = 'claude-code'
  let extraArgs = ''
  let agentArgsDefaults: Record<string, string> = {}

  onMount(() => {
    getAgentArgs()
      .then((c) => (agentArgsDefaults = c))
      .catch(() => {})
  })

  $: savedDefault = (agentArgsDefaults[agentKind] ?? '').trim()

  $: if (session && session.id !== lastId) {
    lastId = session.id
    prompt = session.prompt ?? `Begin implementing ${session.tid}.`
    repoChoice = session.repo ?? session.suggestedRepo ?? null
    menuOpen = false
    agentKind = (session.agentKind as BackendKind) ?? 'claude-code'
    extraArgs = session.extraArgs ?? ''
  }

  // FLO-114: mirror the in-progress kickoff prompt into the store as the
  // user types, so a page reload's persisted-draft restore has the actual
  // text rather than the placeholder set when the draft was created.
  $: if (session?.id && session.status === 'idle' && prompt !== session.prompt) {
    updateDraftPrompt(session.id, prompt)
  }

  $: chosen = repoChoice ? repoById(repoChoice) : undefined
  $: branch = branchFor(session.tid, session.title)

  function start() {
    if (!repoChoice) {
      menuOpen = true
      return
    }
    if (!session.id) return
    startAgent(session.id, repoChoice, prompt, agentKind, extraArgs.trim() || undefined)
  }

  function discard() {
    discardDraft(session)
  }

  function onWindowClick(e: MouseEvent) {
    if (menuOpen && !(e.target as HTMLElement).closest('#cfgRepoSel')) menuOpen = false
  }
</script>

<svelte:window on:click={onWindowClick} />

<div class="config">
  <div class="config-inner">
    <div>
      <label class="lbl-f" for="cfgPrompt">Kickoff prompt</label>
      <textarea id="cfgPrompt" bind:value={prompt} placeholder="Describe the task for this agent…"
      ></textarea>
      <p class="cfg-hint">
        Full ticket details are sent to the agent automatically as context. This is the opening
        message you can tweak.
      </p>
    </div>

    <div>
      <span class="lbl-f">Repository</span>
      <div class="select" id="cfgRepoSel">
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
                on:click={() => {
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
    </div>

    <div>
      <span class="lbl-f">Agent</span>
      <AgentSelector value={agentKind} on:select={(e) => (agentKind = e.detail)} />
      <p class="cfg-hint">{agentOption(agentKind).description}</p>
    </div>

    <div>
      <label class="lbl-f" for="cfgArgs"
        >Extra CLI arguments <span class="muted">(optional)</span></label
      >
      <input
        id="cfgArgs"
        type="text"
        class="cfg-args"
        bind:value={extraArgs}
        placeholder="--advisor --chrome"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
      />
      <p class="cfg-hint">
        {#if !extraArgs.trim() && savedDefault}
          Blank uses your saved default for {agentOption(agentKind).label}:
          <code>{savedDefault}</code>.
        {:else}
          Appended to the {agentOption(agentKind).label} launch command. If they cause an error, it'll
          show on the agent run.
        {/if}
      </p>
    </div>

    <div class="derive">
      <div class="drow">
        <span class="k">Base branch</span><span class="v muted">{chosen?.base ?? '—'}</span>
      </div>
      <div class="drow">
        <span class="k">New branch</span><span class="v"><b>{branch}</b></span>
      </div>
      <div class="drow">
        <span class="k">Worktree</span><span class="v muted"
          >{chosen ? `.worktrees/${chosen.org}-${chosen.name}/${branch}` : '—'}</span
        >
      </div>
    </div>

    <button class="btn btn-primary" style="width:100%;height:40px;font-size:14px" on:click={start}>
      {@html icons.play} Start agent
    </button>
    <button
      class="btn btn-ghost"
      style="width:100%;height:36px;font-size:13px"
      type="button"
      on:click={discard}
    >
      Discard draft
    </button>
  </div>
</div>
