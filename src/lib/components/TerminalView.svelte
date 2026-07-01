<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Terminal, type IDisposable } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { buildScript, C, terminalTheme } from '../term'
  import { repoById, select, resolveNeedsInput, setSessionStatus, removeSession, cleanupAgent, runAppForSession } from '../stores'
  import { hasBackend, onSessionData, writeSession, resizeSession, getSessionBuffer, resumeSession, attachRemoteControl, openInEditor, attachSession, detachSession, takeWrite, onSessionWriteLock } from '../ipc'
  import { pushToast } from '../toast'
  import { mode } from '../theme'
  import { icons } from '../icons'
  import { MOBILE_MEDIA_QUERY } from '../responsive'
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
  let offWriteLock: (() => void) | null = null
  let canWrite = true
  let viewers = 1

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

    const onResize = () => { try { fit.fit() } catch {} }
    window.addEventListener('resize', onResize)
    const unsub = mode.subscribe(() => { if (term) term.options.theme = terminalTheme() })

    return () => { window.removeEventListener('resize', onResize); unsub() }
  })

  $: if (liveMode && session.id) startLive()
  $: if (!liveMode) runSimulation()

  onDestroy(() => {
    cleanupListeners()
    cleanupSimulation()
    if (session.id) detachSession(session.id)
    term?.dispose()
  })

  // ── Live PTY mode ─────────────────────────────────────────────────────────

  let ro: ResizeObserver | null = null
  let offResize: (() => void) | null = null
  const resumedIds = new Set<string>()

  async function startLive() {
    // Lazily respawn a detached session when the user opens it.
    if (session.id && !resumedIds.has(session.id)) {
      resumedIds.add(session.id)
      try { await resumeSession(session.id) } catch { /* already live or not found */ }
    }

    term.reset()
    setTimeout(() => { try { fit.fit() } catch {}; term.focus() }, 40)

    // Subscribe first, hold pre-backlog chunks, then replay snapshot, then flush held.
    let snapSeq = -1
    const held: Array<[string, number]> = []
    offData = onSessionData((sid, chunk, seq) => {
      if (sid !== session.id) return
      if (snapSeq < 0) { held.push([chunk, seq]); return }
      term.write(chunk)
    })
    const snap = await getSessionBuffer(session.id ?? '')
    term.write(snap.data)
    for (const [chunk, seq] of held) { if (seq > snap.seq) term.write(chunk) }
    held.length = 0
    snapSeq = snap.seq

    // Track the write lock so only one client can control the PTY at a time.
    offWriteLock = onSessionWriteLock((state) => {
      if (state.sessionId !== session.id) return
      canWrite = state.canWrite
      viewers = state.viewers
    })
    if (session.id) {
      const lock = await attachSession(session.id)
      canWrite = lock.canWrite
      viewers = lock.viewers
    }

    // Forward keypresses to the PTY (only when this client holds the write lock).
    term.onData((d) => {
      if (session.id && canWrite) writeSession(session.id, d)
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

  }

  function cleanupListeners() {
    if (offData) { offData(); offData = null }
    if (offWriteLock) { offWriteLock(); offWriteLock = null }
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

  async function handleRemoteControl() {
    if (!hasBackend || !session.id) return
    try {
      await attachRemoteControl(session.id)
      setSessionStatus(session.id, 'running')
      term.reset()
      const snap = await getSessionBuffer(session.id)
      term.write(snap.data)
      pushToast('success', 'Remote control attached.')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*':\s*/, '') : String(e))
    }
  }

  async function handleTakeOver() {
    if (!session.id) return
    try {
      const lock = await takeWrite(session.id)
      canWrite = lock.canWrite
      viewers = lock.viewers
      term.focus()
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCleanup() {
    await cleanupAgent(session, { auto: false })
  }

  async function handleOpenEditor() {
    if (!hasBackend || !session.repo || !session.branch) return
    const mobile = typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches
    try {
      await openInEditor({ repoId: session.repo, branch: session.branch, mobile })
      pushToast('success', 'Opening in editor…')
    } catch (e) {
      const msg = e instanceof Error
        ? e.message.replace(/^Error invoking remote method '[^']*':\s*/, '')
        : String(e)
      pushToast('error', msg)
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
      {#if liveMode && viewers > 1}
        <span class="badge mono">{viewers} viewers</span>
      {/if}
      {#if session.prUrl}
        <a class="badge mono" href={session.prUrl} target="_blank" rel="noopener noreferrer">
          {@html icons.externalLink} View PR
        </a>
      {/if}
    </div>
  </div>
  <div class="spacer"></div>
  <button class="btn btn-outline btn-sm" title="Run the app using this repository's start command" disabled={!hasBackend || !session.id || !session.branch || !session.repo} on:click={() => runAppForSession(session)}>{@html icons.play} <span class="btn-label">Run</span></button>
  <button class="btn btn-outline btn-sm" title="Relaunch this agent with Claude Code Remote Control" disabled={!hasBackend || !session.id} on:click={handleRemoteControl}>{@html icons.remote} <span class="btn-label">Remote control</span></button>
  <button class="btn btn-outline btn-sm" title="Open the worktree in your configured editor" disabled={!hasBackend || !session.repo || !session.branch} on:click={handleOpenEditor}>
    {@html icons.externalLink} <span class="btn-label">Editor</span>
  </button>
  <button class="btn btn-outline btn-sm btn-danger" on:click={handleCleanup}>
    {@html icons.trash} <span class="btn-label">Clean up</span>
  </button>
</div>

<div class="term-wrap"><div class="term-mount" bind:this={mountEl}></div></div>

{#if liveMode && !canWrite}
  <div class="alert">
    <span class="ic">{@html icons.remote}</span>
    <div class="tx"><b>View-only</b><span>Another client is controlling this session.</span></div>
    <button class="btn btn-sm" on:click={handleTakeOver}>Take over</button>
  </div>
{/if}

{#if needsInput}
  <div class="alert">
    <span class="ic">{@html icons.alert}</span>
    <div class="tx"><b>Agent needs your input</b><span>{alertMsg}</span></div>
    <div class="keys"><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">↵</span></div>
  </div>
{/if}
