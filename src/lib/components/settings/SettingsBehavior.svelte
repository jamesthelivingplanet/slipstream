<script lang="ts">
  import { onMount } from 'svelte'
  import {
    hasBackend,
    getEditorConfig,
    setEditorConfig,
    getGcPolicy,
    setGcPolicy,
    getSchedulerPolicy,
    setSchedulerPolicy,
  } from '../../ipc'
  import { pushToast } from '../../toast'
  import type { GcPolicy, SchedulerPolicy } from '../../../../electron/shared/contract.js'
  import {
    DEFAULT_GC_POLICY,
    DEFAULT_SCHEDULER_POLICY,
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

  onMount(() => {
    loadEditorConfig()
    loadGcPolicy()
    loadSchedulerPolicy()
  })
</script>

<div class="tab-header">
  <span class="tab-title">Behavior</span>
</div>
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
    Used instead when opening from the mobile layout. Leave blank to use the editor command above.
    Tip: a web-accessible editor such as <code>code serve-web</code> works well here.
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

<div>
  <span class="lbl-f">Session cleanup (cost guard)</span>
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
</div>

<div>
  <span class="lbl-f">Concurrency</span>
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
</div>
