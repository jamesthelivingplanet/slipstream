<script lang="ts">
  import { ticketDialogOpen, createTicketAction } from '../stores'
  import { listTicketTeams, hasBackend } from '../ipc'
  import { icons } from '../icons'
  import type { TicketTeam } from '../types'

  let title = ''
  let description = ''
  let teamId = ''
  let teams: TicketTeam[] = []
  let loadingTeams = false
  let creating = false
  let wasOpen = false
  let menuOpen = false

  $: if ($ticketDialogOpen && !wasOpen) {
    title = ''
    description = ''
    teamId = ''
    teams = []
    wasOpen = true
    if (hasBackend) {
      loadingTeams = true
      listTicketTeams()
        .then((ts) => {
          teams = ts
          if (ts.length === 1) teamId = ts[0].id
        })
        .finally(() => { loadingTeams = false })
    }
  }
  $: if (!$ticketDialogOpen) wasOpen = false

  $: chosenTeam = teams.find((t) => t.id === teamId)
  $: canCreate = title.trim().length > 0 && teamId.length > 0

  async function create() {
    if (!canCreate || creating) return
    creating = true
    try {
      await createTicketAction(title.trim(), description, teamId)
    } finally {
      creating = false
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (menuOpen && !(e.target as HTMLElement).closest('#ntdTeamSel')) menuOpen = false
  }
</script>

<svelte:window on:click={onWindowClick} />

{#if $ticketDialogOpen}
  <div class="overlay" on:click={() => ticketDialogOpen.set(false)} role="presentation"></div>
  <div class="dialog">
    <div class="dlg-head">
      <h2>New ticket</h2>
      <p>Create a ticket in Linear directly from Flotilla.</p>
    </div>

    <div class="dlg-body">
      <div>
        <label class="lbl-f" for="ntdTitle">Title</label>
        <input id="ntdTitle" type="text" bind:value={title} placeholder="What needs to be done?" />
      </div>

      <div>
        <label class="lbl-f" for="ntdDesc">Description <span class="muted" style="font-weight:400">(optional)</span></label>
        <textarea id="ntdDesc" bind:value={description} placeholder="Add more context…"></textarea>
      </div>

      <div>
        <span class="lbl-f">Team</span>
        {#if !hasBackend}
          <p class="muted" style="font-size:0.85em;">Connect Linear in Settings to create tickets.</p>
        {:else if loadingTeams}
          <p class="muted" style="font-size:0.85em;">Loading teams…</p>
        {:else if teams.length === 0}
          <p class="muted" style="font-size:0.85em;">No teams found. Connect Linear in Settings.</p>
        {:else}
          <div class="select" id="ntdTeamSel">
            <button class="sel-trigger" type="button" on:click|stopPropagation={() => (menuOpen = !menuOpen)}>
              {#if chosenTeam}
                <span>{chosenTeam.key} — {chosenTeam.name}</span>
              {:else}
                <span class="muted">Select a team</span>
              {/if}
              <span class="chev">{@html icons.chevronDown}</span>
            </button>
            {#if menuOpen}
              <div class="sel-menu">
                {#each teams as t (t.id)}
                  <button
                    type="button"
                    class="opt"
                    class:sel={teamId === t.id}
                    on:click={() => { teamId = t.id; menuOpen = false }}
                  >
                    <span>{t.key} — {t.name}</span>
                    <span class="check">{@html icons.check}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <div class="dlg-foot">
      <button class="btn btn-ghost" on:click={() => ticketDialogOpen.set(false)}>Cancel</button>
      <button class="btn btn-primary" disabled={!canCreate || creating} on:click={create}>
        {@html icons.plus} {creating ? 'Creating…' : 'Create ticket'}
      </button>
    </div>
  </div>
{/if}
