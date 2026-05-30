<script lang="ts">
  import { repos, repoOf, branchFor } from '../mock'
  import { startAgent } from '../stores'
  import { icons } from '../icons'
  import type { Session } from '../types'

  export let session: Session

  let prompt = ''
  let repoChoice: string | null = null
  let menuOpen = false
  let lastTid = ''

  $: if (session && session.tid !== lastTid) {
    lastTid = session.tid
    prompt = session.prompt ?? `${session.tid}: ${session.title}.`
    repoChoice = session.repo ?? session.suggestedRepo ?? null
    menuOpen = false
  }

  $: chosen = repoChoice ? repoOf(repoChoice) : undefined
  $: branch = branchFor(session.tid, session.title)

  function start() {
    if (!repoChoice) {
      menuOpen = true
      return
    }
    startAgent(session.tid, repoChoice, prompt)
  }

  function onWindowClick(e: MouseEvent) {
    if (menuOpen && !(e.target as HTMLElement).closest('#cfgRepoSel')) menuOpen = false
  }
</script>

<svelte:window on:click={onWindowClick} />

<div class="config">
  <div class="config-inner">
    <div>
      <label class="lbl-f" for="cfgPrompt">Prompt</label>
      <textarea id="cfgPrompt" bind:value={prompt} placeholder="Describe the task for this agent…"></textarea>
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
            {#each repos as r}
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
