<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Terminal, type IDisposable } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { buildScript, C, terminalTheme } from '../term'
  import { repoById, select, resolveNeedsInput, setSessionStatus, removeSession } from '../stores'
  import { hasBackend, onSessionData, onSessionStatus, writeSession, resizeSession, killSession, cleanupSession } from '../ipc'
  import { mode } from '../theme'
  import { icons } from '../icons'
  import type { Session, Status } from '../types'

  export let session: Session

  let mountEl: HTMLDivElement
  let term: Terminal
  let fit: FitAddon
  let timer: ReturnType<typeof setTimeout> | null = null
  let askSub: IDisposable | null = null
  let needsInput = false
  let alertMsg = ''

  // Unsubscribe fns for backend push listeners
  let offData: (() => void) | null = null
  let offStatus: (() => void) | null = null

  $: r = repoById(session.repo)
  $: dot =
    session.status === 'idle'
      ? 'hsl(var(--muted-foreground))'
      : `hsl(var(--st-${session.status === 'needs' ? 'needs' : session.status === 'running' ? 'run' : session.status === 'done' ? 'done' : 'error'}))`

  // Use the live backend PTY whenever a backend is present. The session.id
  // arrives asynchronously (after startSession resolves), so we must not gate
  // on it here — data/status callbacks filter by id once it's set.
  $: liveMode = hasBackend

  onMount(() => {
    term = new Terminal({
      fontFamily: "'Geist Mono', monospace", fontSize: 13, lineHeight: 1.0,
      cursorBlink: true, cursorStyle: 'bar', theme: terminalTheme(),
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mountEl)
    try { fit.fit() } catch {}

    if (liveMode) {
      startLive()
    } else {
      runSimulation()
    }

    const onResize = () => { try { fit.fit() } catch {} }
    window.addEventListener('resize', onResize)
    const unsub = mode.subscribe(() => { if (term) term.options.theme = terminalTheme() })

    return () => { window.removeEventListener('resize', onResize); unsub() }
  })

  onDestroy(() => {
    cleanupListeners()
    cleanupSimulation()
    term?.dispose()
  })

  // ── Live PTY mode ─────────────────────────────────────────────────────────

  let ro: ResizeObserver | null = null
  let offResize: (() => void) | null = null

  function startLive() {
    term.reset()
    setTimeout(() => { try { fit.fit() } catch {}; term.focus() }, 40)

    // Pipe PTY output into xterm (filtered to this session once id is known).
    offData = onSessionData((sid, chunk) => {
      if (sid === session.id) term.write(chunk)
    })

    // Forward keypresses to the PTY.
    term.onData((d) => {
      if (session.id) writeSession(session.id, d)
    })

    // Keep the PTY sized to the panel (window + element resizes).
    const sendResize = () => {
      try { fit.fit() } catch {}
      if (session.id) resizeSession(session.id, term.cols, term.rows)
    }
    if (typeof ResizeObserver !== 'undefined' && mountEl) {
      ro = new ResizeObserver(sendResize)
      ro.observe(mountEl)
    }
    window.addEventListener('resize', sendResize)
    offResize = () => window.removeEventListener('resize', sendResize)

    // Reflect backend status transitions into the store.
    offStatus = onSessionStatus((sid, status) => {
      if (sid === session.id) setSessionStatus(sid, status as Status)
    })
  }

  function cleanupListeners() {
    if (offData) { offData(); offData = null }
    if (offStatus) { offStatus(); offStatus = null }
    if (offResize) { offResize(); offResize = null }
    if (ro) { ro.disconnect(); ro = null }
  }

  // ── Simulation mode ───────────────────────────────────────────────────────

  function cleanupSimulation() {
    if (timer) { clearTimeout(timer); timer = null }
    if (askSub) { askSub.dispose(); askSub = null }
    needsInput = false
  }

  function runSimulation() {
    cleanupSimulation()
    term.reset()
    setTimeout(() => { try { fit.fit() } catch {}; term.focus() }, 40)
    if (!r) return
    const lines = buildScript(session, r)
    let i = 0
    const step = () => {
      if (i >= lines.length) return
      const [text, delay, tag] = lines[i++]
      term.writeln(text)
      if (tag === 'ASK') {
        term.write('\r\n' + C.violet('❯ '))
        alertMsg = session.activity.text
        needsInput = true
        bindAsk()
        return
      }
      if (tag === 'SPIN') return
      timer = setTimeout(step, delay)
    }
    step()
  }

  function bindAsk() {
    askSub = term.onData((d) => {
      if (d === '\r') return
      if (d === '1' || d === '2') {
        term.write(d + '\r\n\r\n')
        term.writeln(C.dim('  ↳ ') + (d === '1' ? 'Invalidating sessions on refresh.' : 'Migrating sessions to the new token.'))
        term.writeln('')
        term.writeln(C.blue('● ') + 'Editing ' + C.dim('src/auth/refresh.ts'))
        needsInput = false
        askSub?.dispose()
        askSub = null
        resolveNeedsInput(session.tid)
        setTimeout(() => term.writeln(C.blue('● ') + 'Running tests…'), 900)
      } else {
        term.write(d)
      }
    })
  }

  // ── Toolbar actions ───────────────────────────────────────────────────────

  async function handleCleanup() {
    if (liveMode && session.id) {
      await killSession(session.id)
      const result = await cleanupSession(session.id, { force: false })
      if (result.removed) {
        removeSession(session.id)
        select(null)
      } else {
        // Dirty/unmerged — force-remove after confirmation.
        if (confirm(`Worktree not clean: ${result.reason ?? 'unknown reason'}. Force remove?`)) {
          await cleanupSession(session.id, { force: true })
          removeSession(session.id)
          select(null)
        }
      }
    } else {
      // Mock: just deselect.
      select(null)
    }
  }
</script>

<div class="term-head">
  <button class="btn btn-ghost btn-icon btn-sm" title="Deselect" on:click={() => select(null)}>
    {@html icons.chevronLeft}
  </button>
  <div class="th-title">
    <div class="t"><span class="stat-dot" style="background:{dot}"></span>{session.tid} · {session.title}</div>
    <div class="m">
      <span class="badge mono">{@html icons.folder} {r?.org}/{r?.name}</span>
      <span class="badge mono">{@html icons.gitBranch} {session.branch}</span>
    </div>
  </div>
  <div class="spacer"></div>
  <button class="btn btn-outline btn-sm" on:click={() => alert('Opens the worktree in your editor (Phase 1)')}>
    {@html icons.externalLink} Editor
  </button>
  <button class="btn btn-outline btn-sm btn-danger" on:click={handleCleanup}>
    {@html icons.trash} Clean up
  </button>
</div>

<div class="term-wrap"><div class="term-mount" bind:this={mountEl}></div></div>

{#if needsInput}
  <div class="alert">
    <span class="ic">{@html icons.alert}</span>
    <div class="tx"><b>Agent needs your input</b><span>{alertMsg}</span></div>
    <div class="keys"><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">↵</span></div>
  </div>
{/if}
