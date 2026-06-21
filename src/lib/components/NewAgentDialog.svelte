<script lang="ts">
  import { dialogOpen, tickets, createAgentFromTicket, createBlankAgent, refreshTickets } from '../stores'
  import { icons } from '../icons'
  import type { Ticket } from '../types'

  let picked: Ticket | null = null
  let title = ''
  let prompt = ''
  let wasOpen = false
  let loadingTickets = false

  $: if ($dialogOpen && !wasOpen) {
    picked = null
    title = ''
    prompt = ''
    wasOpen = true
    // refresh tickets when dialog opens
    loadingTickets = true
    refreshTickets().finally(() => { loadingTickets = false })
  }
  $: if (!$dialogOpen) wasOpen = false

  function pick(t: Ticket) {
    picked = t
    title = t.title
    prompt = `${t.tid}: ${t.title}.\n\nInvestigate and implement a fix. Add tests, then open a PR.`
  }

  function create() {
    if (!title.trim()) return
    if (picked) {
      createAgentFromTicket(picked, prompt)
    } else {
      createBlankAgent(title.trim(), prompt)
    }
  }
</script>

{#if $dialogOpen}
  <div class="overlay" on:click={() => dialogOpen.set(false)} role="presentation"></div>
  <div class="dialog">
    <div class="dlg-head">
      <h2>New agent</h2>
      <p>Create a blank agent or pick a ticket. You'll choose a repo and start it next.</p>
    </div>

    <div class="dlg-body">
      <div>
        <label class="lbl-f" for="dTitle">Title</label>
        <input id="dTitle" type="text" bind:value={title} placeholder="What should this agent work on?" />
      </div>

      {#if loadingTickets || $tickets.length > 0}
        <div>
          <span class="lbl-f">From ticket</span>
          {#if loadingTickets}
            <p class="muted" style="font-size: 0.85em;">Loading tickets…</p>
          {:else}
            <div class="ticket-pick">
              {#each $tickets as t (t.tid)}
                <button type="button" class="tk" class:sel={picked?.tid === t.tid} on:click={() => pick(t)}>
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
        <label class="lbl-f" for="dPrompt">Initial prompt</label>
        <textarea id="dPrompt" bind:value={prompt} placeholder="Describe the task for this agent…"></textarea>
      </div>
    </div>

    <div class="dlg-foot">
      <button class="btn btn-ghost" on:click={() => dialogOpen.set(false)}>Cancel</button>
      <button class="btn btn-primary" disabled={!title.trim()} on:click={create}>{@html icons.plus} Create agent</button>
    </div>
  </div>
{/if}
