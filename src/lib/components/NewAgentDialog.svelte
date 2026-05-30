<script lang="ts">
  import { dialogOpen, tickets, createAgentFromTicket } from '../stores'
  import { icons } from '../icons'
  import type { Ticket } from '../types'

  let picked: Ticket | null = null
  let prompt = ''
  let wasOpen = false

  $: if ($dialogOpen && !wasOpen) {
    picked = null
    prompt = ''
    wasOpen = true
  }
  $: if (!$dialogOpen) wasOpen = false

  function pick(t: Ticket) {
    picked = t
    prompt = `${t.tid}: ${t.title}.\n\nInvestigate and implement a fix. Add tests, then open a PR.`
  }

  function create() {
    if (!picked) return
    createAgentFromTicket(picked, prompt)
  }
</script>

{#if $dialogOpen}
  <div class="overlay" on:click={() => dialogOpen.set(false)} role="presentation"></div>
  <div class="dialog">
    <div class="dlg-head">
      <h2>New agent</h2>
      <p>Create an agent from a ticket. You'll pick the repo and start it next.</p>
    </div>

    <div class="dlg-body">
      <div>
        <span class="lbl-f">From ticket</span>
        <div class="ticket-pick">
          {#each $tickets as t (t.tid)}
            <button type="button" class="tk" class:sel={picked?.tid === t.tid} on:click={() => pick(t)}>
              <span class="badge {t.src}" style="border:none;padding:1px 6px">{t.src}</span>
              <span class="tk-id">{t.tid}</span>
              <span class="tk-t">{t.title}</span>
              <span class="check">{@html icons.check}</span>
            </button>
          {/each}
          {#if $tickets.length === 0}
            <div class="tk-empty">No queued tickets — every ticket already has an agent.</div>
          {/if}
        </div>
      </div>

      <div>
        <label class="lbl-f" for="dPrompt">Initial prompt</label>
        <textarea id="dPrompt" bind:value={prompt} placeholder="Describe the task for this agent…"></textarea>
      </div>
    </div>

    <div class="dlg-foot">
      <button class="btn btn-ghost" on:click={() => dialogOpen.set(false)}>Cancel</button>
      <button class="btn btn-primary" on:click={create}>{@html icons.plus} Create agent</button>
    </div>
  </div>
{/if}
