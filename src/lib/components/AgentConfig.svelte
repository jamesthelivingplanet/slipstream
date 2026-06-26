<script lang="ts">
  import { repos, repoById, startAgent } from '../stores'
  import { branchFor } from '../branch'
  import { icons } from '../icons'
  import type { Session, BackendKind } from '../types'

  export let session: Session

  let prompt = ''
  let repoChoice: string | null = null
  let menuOpen = false
  let lastTid = ''

  let agentKind: BackendKind = 'claude-code'


  $: if (session && session.tid !== lastTid) {
    lastTid = session.tid
    prompt = session.prompt ?? `Begin implementing ${session.tid}.`
    repoChoice = session.repo ?? session.suggestedRepo ?? null
    menuOpen = false
    agentKind = (session.agentKind as BackendKind) ?? 'claude-code'
  }

  $: chosen = repoChoice ? repoById(repoChoice) : undefined
  $: branch = branchFor(session.tid, session.title)

  function start() {
    if (!repoChoice) {
      menuOpen = true
      return
    }
    startAgent(session.tid, repoChoice, prompt, agentKind)
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
      <textarea id="cfgPrompt" bind:value={prompt} placeholder="Describe the task for this agent…"></textarea>
      <p class="cfg-hint">Full ticket details are sent to the agent automatically as context. This is the opening message you can tweak.</p>
    </div>

    <div>
      <span class="lbl-f">Repository</span>
      <div class="select" id="cfgRepoSel">
        <button class="sel-trigger" type="button" on:click|stopPropagation={() => (menuOpen = !menuOpen)}>
          {#if chosen}
            <span><span class="muted">{chosen.org}/</span>{chosen.name}</span>
          {:else}
            <span class="muted">Select a repository</span>
          {/if}
          <span class="chev">{@html icons.chevronDown}</span>
        </button>
        {#if menuOpen}
          <div class="sel-menu">
            {#each $repos as r}
              <button type="button" class="opt" class:sel={repoChoice === r.id} on:click={() => { repoChoice = r.id; menuOpen = false }}>
                <span><span class="muted">{r.org}/</span>{r.name}</span>
                <span class="badge mono" style="margin-left:8px">{r.base}</span>
                <span class="check">{@html icons.check}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <p class="cfg-hint">A fresh worktree is branched from this repo's base branch, and claude starts inside it.</p>
    </div>


    <div>
      <span class="lbl-f">Agent</span>
      <div class="agent-kind-toggle">
        <button type="button" class="toggle-opt" class:active={agentKind === 'claude-code'} on:click={() => agentKind = 'claude-code'}>
          {#if agentKind === 'claude-code'}<span class="check-active">{@html icons.check}</span>{/if}
          Claude Code
        </button>
        <button type="button" class="toggle-opt" class:active={agentKind === 'opencode'} on:click={() => agentKind = 'opencode'}>
          {#if agentKind === 'opencode'}<span class="check-active">{@html icons.check}</span>{/if}
          OpenCode
        </button>
      </div>
      <p class="cfg-hint">{agentKind === 'claude-code' ? 'Uses claude --dangerously-skip-permissions in a git worktree.' : 'Uses opencode in a git worktree with auto-discovered AGENTS.md.'}</p>
    </div>
    <div class="derive">
      <div class="drow"><span class="k">Base branch</span><span class="v muted">{chosen?.base ?? '—'}</span></div>
      <div class="drow"><span class="k">New branch</span><span class="v"><b>{branch}</b></span></div>
      <div class="drow"><span class="k">Worktree</span><span class="v muted">{chosen ? `.worktrees/${chosen.org}-${chosen.name}/${branch}` : '—'}</span></div>
    </div>

    <button class="btn btn-primary" style="width:100%;height:40px;font-size:14px" on:click={start}>
      {@html icons.play} Start agent
    </button>
  </div>
</div>
