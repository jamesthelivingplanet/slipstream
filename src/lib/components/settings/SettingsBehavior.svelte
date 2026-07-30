<script lang="ts">
  import { onMount } from 'svelte'
  import {
    hasBackend,
    getEditorConfig,
    setEditorConfig,
    getAgentArgs,
    setAgentArgs,
    getGcPolicy,
    setGcPolicy,
    getSchedulerPolicy,
    setSchedulerPolicy,
    getSpawnPolicy,
    setSpawnPolicy,
    getBudgetPolicy,
    setBudgetPolicy,
  } from '../../ipc'
  import { pushToast } from '../../toast'
  import { mobile, settingsOpen, settingsRepoId } from '../../stores'
  import {
    fabAngelEnabled,
    fabTipsEnabled,
    initFabPrefs,
    setFabAngelEnabled,
    setFabTipsEnabled,
  } from '../../fabPrefs'
  import { replayOnboarding } from '../../onboarding'
  import SettingsSection from './SettingsSection.svelte'
  import { AGENT_META } from '../../../../electron/shared/agents.js'
  import type {
    GcPolicy,
    SchedulerPolicy,
    SpawnPolicy,
    AgentArgsConfig,
    BudgetPolicy,
  } from '../../../../electron/shared/contract.js'
  import {
    DEFAULT_GC_POLICY,
    DEFAULT_SCHEDULER_POLICY,
    DEFAULT_SPAWN_POLICY,
    DEFAULT_BUDGET_POLICY,
  } from '../../../../electron/shared/contract.js'

  let editorCommand = ''
  let mobileEditorCommand = ''
  let editorPending = false

  async function loadEditorConfig() {
    if (!hasBackend) return
    try {
      const cfg = await getEditorConfig()
      editorCommand = cfg.command
      mobileEditorCommand = cfg.mobileCommand
    } catch {
      /* ignore */
    }
  }
  async function saveEditorConfig() {
    if (!hasBackend) return
    editorPending = true
    try {
      await setEditorConfig({
        command: editorCommand.trim(),
        mobileCommand: mobileEditorCommand.trim(),
      })
      pushToast('success', 'Editor settings saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save editor settings')
    } finally {
      editorPending = false
    }
  }

  let agentArgs: AgentArgsConfig = {}
  let agentArgsPending = false

  async function loadAgentArgs() {
    if (!hasBackend) return
    try {
      agentArgs = await getAgentArgs()
    } catch {
      /* ignore */
    }
  }
  async function saveAgentArgs() {
    if (!hasBackend) return
    agentArgsPending = true
    try {
      await setAgentArgs(agentArgs)
      pushToast('success', 'Agent CLI arguments saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save agent CLI arguments')
    } finally {
      agentArgsPending = false
    }
  }

  let gcPolicy: GcPolicy = { ...DEFAULT_GC_POLICY }
  let gcIdleMin = 0 // minutes, UI-facing (idleMs / 60000)
  let gcMaxAgeMin = 0 // minutes, UI-facing (maxAgeMs / 60000)
  let gcPending = false

  async function loadGcPolicy() {
    if (!hasBackend) return
    try {
      const p = await getGcPolicy()
      gcPolicy = p
      gcIdleMin = Math.round(p.idleMs / 60000)
      gcMaxAgeMin = Math.round(p.maxAgeMs / 60000)
    } catch {
      /* ignore */
    }
  }
  async function saveGcPolicy() {
    if (!hasBackend) return
    gcPending = true
    try {
      const next: GcPolicy = {
        ...gcPolicy,
        idleMs: Math.max(0, Math.round(gcIdleMin)) * 60000,
        maxAgeMs: Math.max(0, Math.round(gcMaxAgeMin)) * 60000,
      }
      await setGcPolicy(next)
      gcPolicy = next
      pushToast('success', 'Session cleanup settings saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      gcPending = false
    }
  }

  let schedPolicy: SchedulerPolicy = { ...DEFAULT_SCHEDULER_POLICY }
  let schedPending = false

  async function loadSchedulerPolicy() {
    if (!hasBackend) return
    try {
      schedPolicy = await getSchedulerPolicy()
    } catch {
      /* ignore */
    }
  }
  async function saveSchedulerPolicy() {
    if (!hasBackend) return
    schedPending = true
    try {
      const next: SchedulerPolicy = {
        ...schedPolicy,
        maxConcurrent: Math.max(0, Math.round(schedPolicy.maxConcurrent)),
      }
      await setSchedulerPolicy(next)
      schedPolicy = next
      pushToast('success', 'Concurrency settings saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      schedPending = false
    }
  }

  let spawnPolicy: SpawnPolicy = { ...DEFAULT_SPAWN_POLICY }
  let spawnPending = false

  async function loadSpawnPolicy() {
    if (!hasBackend) return
    try {
      spawnPolicy = await getSpawnPolicy()
    } catch {
      /* ignore */
    }
  }
  async function saveSpawnPolicy() {
    if (!hasBackend) return
    spawnPending = true
    try {
      const next: SpawnPolicy = {
        maxDepth: Math.max(0, Math.round(spawnPolicy.maxDepth)),
        maxChildrenPerSession: Math.max(0, Math.round(spawnPolicy.maxChildrenPerSession)),
        maxSpawnsPerHour: Math.max(0, Math.round(spawnPolicy.maxSpawnsPerHour)),
      }
      await setSpawnPolicy(next)
      spawnPolicy = next
      pushToast('success', 'Spawn limits saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      spawnPending = false
    }
  }

  let budgetPolicy: BudgetPolicy = { ...DEFAULT_BUDGET_POLICY }
  let budgetPending = false

  async function loadBudgetPolicy() {
    if (!hasBackend) return
    try {
      budgetPolicy = await getBudgetPolicy()
    } catch {
      /* ignore */
    }
  }
  async function saveBudgetPolicy() {
    if (!hasBackend) return
    budgetPending = true
    try {
      const next: BudgetPolicy = {
        ...budgetPolicy,
        dailyUsdCap: Math.max(0, budgetPolicy.dailyUsdCap),
        perSessionUsdCap: Math.max(0, budgetPolicy.perSessionUsdCap),
      }
      await setBudgetPolicy(next)
      budgetPolicy = next
      pushToast('success', 'Budget settings saved')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      budgetPending = false
    }
  }

  // TASK-EQOP4: closes Settings so the replayed onboarding (pager or modal,
  // per onboardingMode()) isn't stacked underneath the still-open panel.
  function handleReplayOnboarding() {
    replayOnboarding()
    settingsOpen.set(false)
    settingsRepoId.set(null)
  }

  function onFabAngelChange(e: Event) {
    setFabAngelEnabled((e.currentTarget as HTMLInputElement).checked)
  }

  function onFabTipsChange(e: Event) {
    setFabTipsEnabled((e.currentTarget as HTMLInputElement).checked)
  }

  onMount(() => {
    loadEditorConfig()
    loadAgentArgs()
    loadGcPolicy()
    loadSchedulerPolicy()
    loadSpawnPolicy()
    loadBudgetPolicy()
    initFabPrefs()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Behavior</span>
</div>
<SettingsSection title="Editor">
  <div class="editor-fields">
    <div>
      <span class="lbl-f">Editor command</span>
      <p class="integration-hint">
        Command run to open a worktree in your editor, e.g. <code>code</code> (VS Code) or
        <code>zed</code> (Zed). The worktree path is appended as an argument.
      </p>
      <input
        type="text"
        class="path-input"
        placeholder="code"
        bind:value={editorCommand}
        disabled={editorPending || !hasBackend}
      />
    </div>
    <div>
      <span class="lbl-f">Mobile editor command (optional)</span>
      <p class="integration-hint">
        Used instead when opening from the mobile layout. Leave blank to use the editor command
        above. Tip: a web-accessible editor such as <code>code serve-web</code> works well here.
      </p>
      <div class="path-add">
        <input
          type="text"
          class="path-input"
          placeholder="code serve-web"
          bind:value={mobileEditorCommand}
          disabled={editorPending || !hasBackend}
        />
        <button
          class="btn btn-outline btn-sm"
          on:click={saveEditorConfig}
          disabled={editorPending || !hasBackend}
        >
          Save
        </button>
      </div>
      {#if !hasBackend}
        <p class="integration-hint muted">Backend not available in browser-only mode.</p>
      {/if}
    </div>
  </div>
</SettingsSection>

<SettingsSection title="Agent CLI arguments">
  <p class="integration-hint">
    Extra arguments appended to each agent's launch command for every run of that type. Leave a
    run's own field blank to use these; fill it to override for that run.
  </p>
  {#each AGENT_META as a (a.kind)}
    <div class="repo-settings-field">
      <label class="lbl-f" for={`args-${a.kind}`}>{a.label}</label>
      <input
        id={`args-${a.kind}`}
        type="text"
        class="path-input"
        placeholder="--advisor --chrome"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        bind:value={agentArgs[a.kind]}
        disabled={agentArgsPending || !hasBackend}
      />
    </div>
  {/each}
  <button
    class="btn btn-outline btn-sm"
    style="margin-top:8px"
    on:click={saveAgentArgs}
    disabled={agentArgsPending || !hasBackend}>Save</button
  >
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</SettingsSection>

<SettingsSection title="Tour">
  <p class="integration-hint">
    Replay the first-boot walkthrough of Slipstream's core features, guided by Nulliel.
  </p>
  <button type="button" class="btn btn-outline btn-sm" on:click={handleReplayOnboarding}>
    Replay intro
  </button>
</SettingsSection>

<SettingsSection title="Session cleanup (cost guard)">
  <p class="integration-hint">
    Automatically stop abandoned or idle agent sessions so forgotten agents don't keep burning
    compute. Reaped sessions stay visible in the sidebar marked <b>Reaped</b>.
  </p>
  <label class="notify-check">
    <input type="checkbox" bind:checked={gcPolicy.enabled} disabled={gcPending || !hasBackend} />
    Enable automatic cleanup
  </label>
  <label class="notify-check">
    <input
      type="checkbox"
      bind:checked={gcPolicy.onlyAbandoned}
      disabled={gcPending || !hasBackend || !gcPolicy.enabled}
    />
    Only reap sessions with no one watching
  </label>
  <label class="notify-check">
    <input
      type="checkbox"
      bind:checked={gcPolicy.autoStopOnDone}
      disabled={gcPending || !hasBackend || !gcPolicy.enabled}
    />
    Stop finished (done) agents automatically
  </label>
  <div class="repo-settings-field" style="margin-top:8px">
    <label class="lbl-f" for="gc-idle">Idle timeout (minutes, 0 = off)</label>
    <input
      id="gc-idle"
      type="number"
      min="0"
      class="path-input"
      bind:value={gcIdleMin}
      disabled={gcPending || !hasBackend || !gcPolicy.enabled}
    />
  </div>
  <div class="repo-settings-field">
    <label class="lbl-f" for="gc-maxage">Max session age (minutes, 0 = off)</label>
    <input
      id="gc-maxage"
      type="number"
      min="0"
      class="path-input"
      bind:value={gcMaxAgeMin}
      disabled={gcPending || !hasBackend || !gcPolicy.enabled}
    />
  </div>
  <button
    class="btn btn-outline btn-sm"
    style="margin-top:8px"
    on:click={saveGcPolicy}
    disabled={gcPending || !hasBackend}>Save</button
  >
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</SettingsSection>

<SettingsSection title="Concurrency">
  <p class="integration-hint">
    Cap how many agent sessions run at once. Starts beyond the cap are queued and launch
    automatically as running agents finish or are reaped.
  </p>
  <div class="repo-settings-field">
    <label class="lbl-f" for="sched-max">Max concurrent agents (0 = unlimited)</label>
    <input
      id="sched-max"
      type="number"
      min="0"
      class="path-input"
      bind:value={schedPolicy.maxConcurrent}
      disabled={schedPending || !hasBackend}
    />
  </div>
  <button
    class="btn btn-outline btn-sm"
    style="margin-top:8px"
    on:click={saveSchedulerPolicy}
    disabled={schedPending || !hasBackend}>Save</button
  >
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</SettingsSection>

<SettingsSection title="Spawn limits">
  <p class="integration-hint">
    Agents can ask the daemon to launch other agents (<code>slipstream new-agent</code>). These caps
    bound how far that can fan out — a runaway agent can't spawn an unbounded chain of sibling PTYs
    and API cost.
  </p>
  <div class="repo-settings-field">
    <label class="lbl-f" for="spawn-depth">Max spawn depth (0 = unlimited)</label>
    <input
      id="spawn-depth"
      type="number"
      min="0"
      class="path-input"
      bind:value={spawnPolicy.maxDepth}
      disabled={spawnPending || !hasBackend}
    />
  </div>
  <div class="repo-settings-field">
    <label class="lbl-f" for="spawn-children">Max children per session (0 = unlimited)</label>
    <input
      id="spawn-children"
      type="number"
      min="0"
      class="path-input"
      bind:value={spawnPolicy.maxChildrenPerSession}
      disabled={spawnPending || !hasBackend}
    />
  </div>
  <div class="repo-settings-field">
    <label class="lbl-f" for="spawn-rate">Max spawns per hour, per session (0 = unlimited)</label>
    <input
      id="spawn-rate"
      type="number"
      min="0"
      class="path-input"
      bind:value={spawnPolicy.maxSpawnsPerHour}
      disabled={spawnPending || !hasBackend}
    />
  </div>
  <button
    class="btn btn-outline btn-sm"
    style="margin-top:8px"
    on:click={saveSpawnPolicy}
    disabled={spawnPending || !hasBackend}>Save</button
  >
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</SettingsSection>

<SettingsSection title="Budget">
  <p class="integration-hint">
    Cap estimated API spend so a runaway or forgotten agent fleet can't burn cost with no backstop
    but a human noticing. Costs here are an <b>estimate</b> derived from token counts and list pricing,
    not an exact invoice — treat these caps as a safety net, not a precise ledger.
  </p>
  <p class="integration-hint">
    Grok, Kilo Code, and Antigravity sessions have no usage reader at all, so their real spend is
    always reported as unmeasured — it is <b>not</b> counted toward these caps and does not read as "$0
    confirmed free". A fleet running only those backends will not trip these limits no matter how much
    it actually costs.
  </p>
  <label class="notify-check">
    <input
      type="checkbox"
      bind:checked={budgetPolicy.enabled}
      disabled={budgetPending || !hasBackend}
    />
    Enable budget caps
  </label>
  <div class="repo-settings-field" style="margin-top:8px">
    <label class="lbl-f" for="budget-daily">Daily spend cap, USD (0 = unlimited)</label>
    <input
      id="budget-daily"
      type="number"
      min="0"
      step="0.01"
      class="path-input"
      bind:value={budgetPolicy.dailyUsdCap}
      disabled={budgetPending || !hasBackend || !budgetPolicy.enabled}
    />
  </div>
  <div class="repo-settings-field">
    <label class="lbl-f" for="budget-session">Per-session spend cap, USD (0 = unlimited)</label>
    <input
      id="budget-session"
      type="number"
      min="0"
      step="0.01"
      class="path-input"
      bind:value={budgetPolicy.perSessionUsdCap}
      disabled={budgetPending || !hasBackend || !budgetPolicy.enabled}
    />
  </div>
  <button
    class="btn btn-outline btn-sm"
    style="margin-top:8px"
    on:click={saveBudgetPolicy}
    disabled={budgetPending || !hasBackend}>Save</button
  >
  {#if !hasBackend}
    <p class="integration-hint muted">Backend not available in browser-only mode.</p>
  {/if}
</SettingsSection>

{#if $mobile}
  <!-- Mobile-only concern, so hidden entirely on desktop/web the same way
       SettingsServer.svelte only appears inside the Capacitor shell. -->
  <SettingsSection title="Mobile FAB">
    <p class="integration-hint">
      Settings for the floating "New agent" button that replaces the header button on mobile.
    </p>
    <label class="notify-check">
      <input type="checkbox" checked={$fabAngelEnabled} on:change={onFabAngelChange} />
      Angel mode (pixel-art glyph instead of a plain button)
    </label>
    <label class="notify-check">
      <input type="checkbox" checked={$fabTipsEnabled} on:change={onFabTipsChange} />
      Occasional tips
    </label>
  </SettingsSection>
{/if}

<style>
  .editor-fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
</style>
