<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Terminal, type IDisposable } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import { buildScript, C, terminalTheme } from '../term'
  import {
    repoById,
    select,
    resolveNeedsInput,
    setSessionStatus,
    setSessionAgent,
    cleanupAgent,
    runAppForSession,
    stopAppForSession,
    restartAppForSession,
    refreshAppStatus,
    runningApps,
    appUrls,
    appRunKey,
    cleanError,
    reviewComments,
    mobile,
  } from '../stores'
  import {
    hasBackend,
    onSessionData,
    writeSession,
    resizeSession,
    getSessionBuffer,
    resumeSession,
    attachRemoteControl,
    handoffSession,
    checkAgentCli,
    openInEditor,
    attachSession,
    detachSession,
    takeWrite,
    onSessionWriteLock,
    onSessionExit,
    getPrStatus,
  } from '../ipc'
  import { pushToast } from '../toast'
  import { mode } from '../theme'
  import { icons } from '../icons'
  import type { Session, WorkflowState, BackendKind } from '../types'
  import type { PrStatusDTO } from '../../../electron/shared/contract.js'
  import { getTicketStatus, setTicketStatus } from '../ipc'
  import { contentLoading, contentResolvedAt, contentRefreshNonce } from '../stores'
  import { floatingAnchor } from '../floating'
  import { AGENTS, agentOption } from '../agents'
  import DiffView from './DiffView.svelte'

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
  let offExit: (() => void) | null = null
  let onDataSub: IDisposable | null = null
  let canWrite = true
  let viewers = 1
  let exited = false
  let exitCode: number | null = null
  let restarting = false
  let handoffOpen = false
  let handingOff = false
  let liveId: string | null | undefined = null
  let simStarted = false
  let showDiff = false
  let current: WorkflowState | null = null
  let available: WorkflowState[] = []
  let statusLoading = false
  let statusError: string | null = null
  let menuOpen = false
  let moreOpen = false
  let lastTid = ''
  let lastNonce = 0

  $: r = repoById(session.repo)
  $: pendingCommentCount = ($reviewComments[session.id ?? ''] ?? []).length
  $: dot =
    session.status === 'idle' || session.status === 'queued'
      ? 'hsl(var(--muted-foreground))'
      : `hsl(var(--st-${session.status === 'needs' ? 'needs' : session.status === 'running' ? 'run' : session.status === 'done' ? 'done' : 'error'}))`

  $: runKey = appRunKey(session)
  $: appRunning = runKey ? $runningApps.has(runKey) : false
  $: appUrl = runKey ? $appUrls[runKey] : undefined

  $: currentKind = (session.agentKind ?? 'claude-code') as BackendKind
  $: handoffTargets = AGENTS.filter((a) => a.kind !== currentKind)

  function openLink(_event: MouseEvent, uri: string) {
    window.open(uri, '_blank', 'noopener,noreferrer')
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: "'Geist Mono', monospace",
      fontSize: 13,
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: terminalTheme(),
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon(openLink))
    term.open(mountEl)
    try {
      fit.fit()
    } catch {}

    const onResize = () => {
      try {
        fit.fit()
      } catch {}
    }
    window.addEventListener('resize', onResize)
    const unsub = mode.subscribe(() => {
      if (term) term.options.theme = terminalTheme()
    })

    return () => {
      window.removeEventListener('resize', onResize)
      unsub()
    }
  })

  const liveMode = hasBackend

  let statusCheckedFor: string | null = null
  $: if (hasBackend && session.id && session.id !== statusCheckedFor) {
    statusCheckedFor = session.id
    refreshAppStatus(session)
  }

  // FLO-96: post-handoff PR/MR status. One fetch when the session has both an
  // id and a prUrl (on mount, or as soon as prUrl appears) — no polling here,
  // mission control already keeps this warm in the backend TTL cache.
  let prStatus: PrStatusDTO | null = null
  let prCheckedFor: string | null = null
  function refreshPrStatus(id: string | undefined, prUrl: string | undefined) {
    if (!liveMode || !hasBackend || !id || !prUrl) return
    const key = `${id}:${prUrl}`
    if (key === prCheckedFor) return
    prCheckedFor = key
    // Clear the previous session's badges immediately, and only accept the
    // resolution if this is still the fetch for the current key — a slow
    // fetch for a previous session must not overwrite the new one's state.
    prStatus = null
    getPrStatus(id)
      .then((dto) => {
        if (prCheckedFor === key) prStatus = dto
      })
      .catch(() => {
        if (prCheckedFor === key) prStatus = null
      })
  }
  $: refreshPrStatus(session.id, session.prUrl)

  interface PrBadge {
    text: string
    cls: 'done' | 'error' | 'needs' | 'muted'
  }

  function prBadges(dto: PrStatusDTO | null): PrBadge[] {
    if (!dto) return []
    if (dto.error) return [{ text: 'PR ?', cls: 'muted' }]
    const badges: PrBadge[] = []
    if (dto.state === 'merged') badges.push({ text: 'merged', cls: 'done' })
    else if (dto.state === 'open') badges.push({ text: 'open', cls: 'muted' })
    else if (dto.state === 'closed') badges.push({ text: 'closed', cls: 'error' })
    if (dto.ci === 'passed') badges.push({ text: 'CI ✓', cls: 'done' })
    else if (dto.ci === 'failed') badges.push({ text: 'CI ✗', cls: 'error' })
    else if (dto.ci === 'pending' || dto.ci === 'running')
      badges.push({ text: 'CI …', cls: 'needs' })
    if (dto.review === 'approved') badges.push({ text: 'approved', cls: 'done' })
    else if (dto.review === 'changes_requested') badges.push({ text: 'changes', cls: 'error' })
    return badges
  }

  $: if (liveMode && session.id && session.id !== liveId) startLive()
  $: if (!liveMode && !simStarted) {
    simStarted = true
    runSimulation()
  }

  onDestroy(() => {
    contentLoading.set(false)
    cleanupListeners()
    cleanupSimulation()
    simStarted = false
    if (session.id) detachSession(session.id)
    term?.dispose()
  })

  // ── Live PTY mode ─────────────────────────────────────────────────────────

  let ro: ResizeObserver | null = null
  let offResize: (() => void) | null = null
  const resumedIds = new Set<string>()

  async function startLive() {
    if (liveId !== null && liveId !== session.id) cleanupListeners()
    liveId = session.id
    exited = false
    exitCode = null

    // FLO-95: a queued session hasn't started yet — resuming it would be a
    // no-op backend-side (the scheduler guards against jumping the queue),
    // and its PTY data/status arrive automatically once a slot frees.
    if (session.id && session.status !== 'queued' && !resumedIds.has(session.id)) {
      resumedIds.add(session.id)
      try {
        await resumeSession(session.id)
      } catch {
        /* already live or not found */
      }
    }

    term.reset()
    setTimeout(() => {
      try {
        fit.fit()
      } catch {}
      term.focus()
    }, 40)

    let snapSeq = -1
    const held: Array<[string, number]> = []
    offData = onSessionData((sid, chunk, seq) => {
      if (sid !== session.id) return
      if (snapSeq < 0) {
        held.push([chunk, seq])
        return
      }
      term.write(chunk)
    })
    const snap = await getSessionBuffer(session.id ?? '')
    term.write(snap.data)
    for (const [chunk, seq] of held) {
      if (seq > snap.seq) term.write(chunk)
    }
    held.length = 0
    snapSeq = snap.seq

    offWriteLock = onSessionWriteLock((state) => {
      if (state.sessionId !== session.id) return
      canWrite = state.canWrite
      viewers = state.viewers
    })
    offExit = onSessionExit((sid, code) => {
      if (sid !== session.id) return
      exited = true
      exitCode = code
    })
    if (session.id) {
      const lock = await attachSession(session.id)
      canWrite = lock.canWrite
      viewers = lock.viewers
    }

    onDataSub = term.onData((d) => {
      if (session.id && canWrite) writeSession(session.id, d)
    })

    const sendResize = () => {
      try {
        fit.fit()
      } catch {}
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
    if (offData) {
      offData()
      offData = null
    }
    if (offWriteLock) {
      offWriteLock()
      offWriteLock = null
    }
    if (offExit) {
      offExit()
      offExit = null
    }
    if (offResize) {
      offResize()
      offResize = null
    }
    if (ro) {
      ro.disconnect()
      ro = null
    }
    if (onDataSub) {
      onDataSub.dispose()
      onDataSub = null
    }
    liveId = null
  }

  // ── Simulation mode ───────────────────────────────────────────────────────

  function cleanupSimulation() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (askSub) {
      askSub.dispose()
      askSub = null
    }
    needsInput = false
  }

  function runSimulation() {
    cleanupSimulation()
    term.reset()
    setTimeout(() => {
      try {
        fit.fit()
      } catch {}
      term.focus()
    }, 40)
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
        term.writeln(
          C.dim('  ↳ ') +
            (d === '1'
              ? 'Invalidating sessions on refresh.'
              : 'Migrating sessions to the new token.'),
        )
        term.writeln('')
        term.writeln(C.blue('● ') + 'Editing ' + C.dim('src/auth/refresh.ts'))
        needsInput = false
        askSub?.dispose()
        askSub = null
        if (session.id) resolveNeedsInput(session.id)
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
      pushToast('error', cleanError(e))
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

  async function handleRestart() {
    if (!hasBackend || !session.id || restarting) return
    restarting = true
    try {
      resumedIds.add(session.id)
      await resumeSession(session.id)
      exited = false
      exitCode = null
      cleanupListeners()
      await startLive()
      pushToast('success', 'Agent restarted.')
    } catch (e) {
      pushToast('error', cleanError(e))
    } finally {
      restarting = false
    }
  }

  async function handleHandoff(kind: BackendKind) {
    if (!hasBackend || !session.id || handingOff) return
    handingOff = true
    handoffOpen = false
    try {
      const cli = await checkAgentCli(kind)
      if (!cli.found) {
        pushToast(
          'error',
          `${agentOption(kind).label} CLI ('${cli.bin}') was not found on the server's PATH.`,
        )
        return
      }
      resumedIds.add(session.id)
      await handoffSession(session.id, kind)
      setSessionAgent(session.id, kind)
      setSessionStatus(session.id, 'running')
      exited = false
      exitCode = null
      cleanupListeners()
      await startLive()
      pushToast(
        'success',
        `Run handed off to ${agentOption(kind).label} — continuing from the existing worktree.`,
      )
    } catch (e) {
      pushToast('error', cleanError(e))
    } finally {
      handingOff = false
    }
  }

  async function handleOpenEditor() {
    if (!hasBackend || !session.repo || !session.branch) return
    try {
      await openInEditor({ repoId: session.repo, branch: session.branch, mobile: $mobile })
      pushToast('success', 'Opening in editor…')
    } catch (e) {
      pushToast('error', cleanError(e))
    }
  }

  // Re-focus the (never-unmounted) terminal after the Diff view is hidden again.
  function refocusTerm() {
    setTimeout(() => {
      try {
        fit.fit()
      } catch {}
      term.focus()
    }, 40)
  }

  function toggleDiff() {
    showDiff = !showDiff
    if (!showDiff) refocusTerm()
  }

  function handleDiffSubmitted() {
    showDiff = false
    refocusTerm()
  }

  $: isBlank = session.tid.startsWith('TASK-')
  $: shouldShow = !isBlank && hasBackend

  function fetchStatus() {
    statusLoading = true
    statusError = null
    menuOpen = false
    contentLoading.set(true)
    getTicketStatus(session.tid, session.src)
      .then((res) => {
        current = res.current
        available = res.available
        contentResolvedAt.set(Date.now())
      })
      .catch((e) => {
        statusError = e instanceof Error ? e.message : 'Failed to load status'
      })
      .finally(() => {
        statusLoading = false
        contentLoading.set(false)
      })
  }

  $: if (shouldShow && session.tid !== lastTid) {
    lastTid = session.tid
    fetchStatus()
  }

  $: if (shouldShow && $contentRefreshNonce !== lastNonce) {
    lastNonce = $contentRefreshNonce
    fetchStatus()
  }

  async function selectState(state: WorkflowState) {
    const prev = current
    current = state
    menuOpen = false
    try {
      const updated = await setTicketStatus(session.tid, state.id, session.src)
      current = updated
    } catch (e) {
      current = prev
      pushToast('error', e instanceof Error ? e.message : 'Failed to update status')
    }
  }

  function onWindowClick(e: MouseEvent) {
    const t = e.target as HTMLElement
    if (menuOpen && !t.closest('#ticketStatusSel') && !t.closest('#ticketStatusSelMob'))
      menuOpen = false
    if (handoffOpen && !t.closest('#handoffSel') && !t.closest('#handoffSelMob'))
      handoffOpen = false
    if (moreOpen && !t.closest('#moreSelMob')) moreOpen = false
  }

  function onTriggerClick() {
    if (!statusError && available.length > 0) menuOpen = !menuOpen
  }
</script>

<svelte:window on:click={onWindowClick} />

<div class="term-head">
  <button class="btn btn-ghost btn-icon btn-sm" title="Deselect" on:click={() => select(null)}>
    {@html icons.chevronLeft}
  </button>
  <div class="th-title">
    <div class="t">
      <span class="stat-dot" style="background:{dot}"></span>{session.tid} · {session.title}
    </div>
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
        {#each prBadges(prStatus) as b (b.text)}
          <span class="badge mono pr-badge-{b.cls}" title={prStatus?.error}>{b.text}</span>
        {/each}
      {/if}
    </div>
  </div>
  <div class="spacer"></div>
  {#if !$mobile}
    {#if shouldShow}
      <div class="sel-head" id="ticketStatusSel">
        {#if statusLoading && !current && available.length === 0}
          <button class="btn btn-outline btn-sm status-trigger" type="button" disabled>
            <span class="muted">Loading…</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
        {:else if statusError}
          <button
            class="btn btn-outline btn-sm status-trigger"
            type="button"
            disabled
            title={statusError}
          >
            <span class="muted">Status unavailable</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
        {:else if available.length === 0}
          <button class="btn btn-outline btn-sm status-trigger" type="button" disabled>
            <span class="muted">{current?.name ?? 'No statuses'}</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
        {:else}
          <button
            class="btn btn-outline btn-sm status-trigger"
            type="button"
            on:click|stopPropagation={onTriggerClick}
          >
            <span>{current?.name ?? 'Set status'}</span>
            <span class="chev">{@html icons.chevronDown}</span>
          </button>
          {#if menuOpen}
            <div class="sel-menu" use:floatingAnchor>
              {#each available as state (state.id)}
                <button
                  type="button"
                  class="opt"
                  class:sel={current?.id === state.id}
                  on:click={() => selectState(state)}
                >
                  <span>{state.name}</span>
                  <span class="check">{@html icons.check}</span>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
    <button
      class="btn btn-outline btn-sm"
      class:btn-active={showDiff}
      title="Review the worktree diff and comment on lines"
      disabled={!session.repo || !session.branch}
      on:click={toggleDiff}
    >
      {@html icons.fileDiff} <span class="btn-label">Diff</span>
      {#if pendingCommentCount > 0}
        <span class="diff-count">{pendingCommentCount}</span>
      {/if}
    </button>
    {#if appRunning}
      {#if appUrl}
        <a
          class="btn btn-outline btn-sm"
          title="Open the running app over Tailscale"
          href={appUrl}
          target="_blank"
          rel="noopener noreferrer"
          >{@html icons.externalLink} <span class="btn-label">Open app</span></a
        >
      {/if}
      <button
        class="btn btn-outline btn-sm"
        title="Stop the running app"
        disabled={!hasBackend || !session.id || !session.branch || !session.repo}
        on:click={() => stopAppForSession(session)}
        >{@html icons.stop} <span class="btn-label">Stop</span></button
      >
      <button
        class="btn btn-outline btn-sm"
        title="Restart the running app"
        disabled={!hasBackend || !session.id || !session.branch || !session.repo}
        on:click={() => restartAppForSession(session)}
        >{@html icons.refresh} <span class="btn-label">Restart</span></button
      >
    {:else}
      <button
        class="btn btn-outline btn-sm"
        title="Run the app using this repository's start command"
        disabled={!hasBackend || !session.id || !session.branch || !session.repo}
        on:click={() => runAppForSession(session)}
        >{@html icons.play} <span class="btn-label">Run</span></button
      >
    {/if}
    <button
      class="btn btn-outline btn-sm"
      title="Relaunch this agent with Claude Code Remote Control"
      disabled={!hasBackend || !session.id}
      on:click={handleRemoteControl}
      >{@html icons.remote} <span class="btn-label">Remote control</span></button
    >
    <div class="sel-head" id="handoffSel">
      <button
        class="btn btn-outline btn-sm"
        title="Continue this run with a different agent (e.g. when this one hit its limits)"
        disabled={!hasBackend || !session.id || session.status === 'queued' || handingOff}
        on:click|stopPropagation={() => (handoffOpen = !handoffOpen)}
        >{@html icons.refresh}
        <span class="btn-label">{handingOff ? 'Handing off…' : 'Hand off'}</span></button
      >
      {#if handoffOpen}
        <div class="sel-menu" use:floatingAnchor>
          {#each handoffTargets as agent (agent.kind)}
            <button type="button" class="opt" on:click={() => handleHandoff(agent.kind)}>
              <span>Continue with {agent.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button
      class="btn btn-outline btn-sm"
      title="Open the worktree in your configured editor"
      disabled={!hasBackend || !session.repo || !session.branch}
      on:click={handleOpenEditor}
    >
      {@html icons.externalLink} <span class="btn-label">Editor</span>
    </button>
    <button class="btn btn-outline btn-sm btn-danger" on:click={handleCleanup}>
      {@html icons.trash} <span class="btn-label">Clean up</span>
    </button>
  {/if}
</div>

<div class="term-wrap" class:hidden={showDiff}>
  <div class="term-mount" bind:this={mountEl}></div>
</div>

{#if showDiff}
  <DiffView {session} {canWrite} onSubmitted={handleDiffSubmitted} />
{/if}

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
    <div class="keys">
      <span class="kbd">1</span><span class="kbd">2</span><span class="kbd">↵</span>
    </div>
  </div>
{/if}

{#if liveMode && exited}
  <div class="alert">
    <span class="ic">{@html icons.refresh}</span>
    <div class="tx">
      <b>Agent closed out</b>
      <span>
        {exitCode === 0
          ? 'The agent process exited.'
          : `The agent process exited with code ${exitCode}.`}
        Restart it to keep working in the same worktree, or hand the run off to a different agent.
      </span>
    </div>
    <button class="btn btn-sm" disabled={restarting} on:click={handleRestart}>
      {restarting ? 'Restarting…' : 'Restart'}
    </button>
    {#each handoffTargets as agent (agent.kind)}
      <button class="btn btn-sm" disabled={handingOff} on:click={() => handleHandoff(agent.kind)}>
        Continue with {agent.label}
      </button>
    {/each}
  </div>
{/if}

{#if $mobile}
  <div class="term-actions">
    {#if shouldShow}
      <div class="sel-head" id="ticketStatusSelMob">
        <button
          class="btn btn-outline btn-sm status-trigger"
          type="button"
          disabled={!!statusError || available.length === 0}
          title={statusError ?? current?.name ?? 'Set status'}
          on:click|stopPropagation={onTriggerClick}
        >
          <span class="stat-dot" style="background:{dot}"></span>
          <span class="chev">{@html icons.chevronDown}</span>
        </button>
        {#if menuOpen}
          <div class="sel-menu" use:floatingAnchor>
            {#each available as state (state.id)}
              <button
                type="button"
                class="opt"
                class:sel={current?.id === state.id}
                on:click={() => selectState(state)}
              >
                <span>{state.name}</span>
                <span class="check">{@html icons.check}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <button
      class="btn btn-outline btn-sm"
      class:btn-active={showDiff}
      title="Review the worktree diff and comment on lines"
      disabled={!session.repo || !session.branch}
      on:click={toggleDiff}
    >
      {@html icons.fileDiff}
      {#if pendingCommentCount > 0}
        <span class="diff-count">{pendingCommentCount}</span>
      {/if}
    </button>
    <div class="sel-head" id="handoffSelMob">
      <button
        class="btn btn-outline btn-sm"
        title="Continue this run with a different agent"
        disabled={!hasBackend || !session.id || session.status === 'queued' || handingOff}
        on:click|stopPropagation={() => (handoffOpen = !handoffOpen)}>{@html icons.refresh}</button
      >
      {#if handoffOpen}
        <div class="sel-menu" use:floatingAnchor>
          {#each handoffTargets as agent (agent.kind)}
            <button type="button" class="opt" on:click={() => handleHandoff(agent.kind)}>
              <span>Continue with {agent.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button class="btn btn-outline btn-sm btn-danger" title="Clean up" on:click={handleCleanup}>
      {@html icons.trash}
    </button>
    <div class="sel-head" id="moreSelMob">
      <button
        class="btn btn-outline btn-sm"
        type="button"
        title="More actions"
        on:click|stopPropagation={() => (moreOpen = !moreOpen)}>{@html icons.more}</button
      >
      {#if moreOpen}
        <div class="sel-menu" use:floatingAnchor>
          {#if appRunning}
            {#if appUrl}
              <button
                type="button"
                class="opt"
                on:click={() => {
                  moreOpen = false
                  window.open(appUrl, '_blank', 'noopener,noreferrer')
                }}
              >
                <span>{@html icons.externalLink} Open app</span>
              </button>
            {/if}
            <button
              type="button"
              class="opt"
              disabled={!hasBackend || !session.id || !session.branch || !session.repo}
              on:click={() => {
                moreOpen = false
                stopAppForSession(session)
              }}
            >
              <span>{@html icons.stop} Stop</span>
            </button>
            <button
              type="button"
              class="opt"
              disabled={!hasBackend || !session.id || !session.branch || !session.repo}
              on:click={() => {
                moreOpen = false
                restartAppForSession(session)
              }}
            >
              <span>{@html icons.refresh} Restart</span>
            </button>
          {:else}
            <button
              type="button"
              class="opt"
              disabled={!hasBackend || !session.id || !session.branch || !session.repo}
              on:click={() => {
                moreOpen = false
                runAppForSession(session)
              }}
            >
              <span>{@html icons.play} Run</span>
            </button>
          {/if}
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.id}
            on:click={() => {
              moreOpen = false
              handleRemoteControl()
            }}
          >
            <span>{@html icons.remote} Remote control</span>
          </button>
          <button
            type="button"
            class="opt"
            disabled={!hasBackend || !session.repo || !session.branch}
            on:click={() => {
              moreOpen = false
              handleOpenEditor()
            }}
          >
            <span>{@html icons.externalLink} Editor</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* The terminal wrapper is only ever CSS-hidden (never unmounted) so xterm,
     the PTY attach, and the write-lock subscription survive toggling to the
     Diff view and back. */
  .hidden {
    display: none;
  }

  .btn-active {
    background: hsl(var(--primary) / 0.12);
    border-color: hsl(var(--primary) / 0.5);
    color: hsl(var(--primary));
  }

  /* PR/CI status badges (FLO-96) */
  .pr-badge-done {
    color: hsl(var(--st-done));
    border-color: hsl(var(--st-done) / 0.4);
  }
  .pr-badge-error {
    color: hsl(var(--st-error));
    border-color: hsl(var(--st-error) / 0.4);
  }
  .pr-badge-needs {
    color: hsl(var(--st-needs));
    border-color: hsl(var(--st-needs) / 0.4);
  }

  .diff-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
  }

  .status-trigger {
    font-family: 'Geist Mono', monospace;
    font-size: 12px;
    min-width: 100px;
    gap: 4px;
  }
  .status-trigger .chev {
    color: hsl(var(--muted-foreground));
    display: flex;
  }
  .sel-head {
    position: relative;
  }
  .sel-menu {
    position: absolute;
    top: 38px;
    left: 0;
    z-index: 60;
    padding: 5px;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    max-height: 260px;
    overflow-y: auto;
    animation: pop 0.14s ease;
    min-width: 160px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: calc(var(--radius) - 3px);
    cursor: pointer;
    font-family: 'Geist Mono', monospace;
    font-size: 12px;
    width: 100%;
  }
  .opt:hover {
    background: hsl(var(--accent-bg));
  }
  .opt .check {
    margin-left: auto;
    color: hsl(var(--primary));
    opacity: 0;
  }
  .opt.sel .check {
    opacity: 1;
  }
</style>
