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
    updateAgentFromBase,
    runningApps,
    appUrls,
    appRunKey,
    cleanError,
    reviewComments,
    mobile,
    markSessionInput,
    connected,
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
    onConnectionChange,
    onPendingInputChange,
    syncClipboardImage,
    getChatMessages,
  } from '../ipc'
  import { pushToast } from '../toast'
  import { mode } from '../theme'
  import { uploadClipboardImage, type ImageUploadDeps } from '../imageUpload'
  import type { Session, WorkflowState, BackendKind } from '../types'
  import type { PrStatusDTO, WorktreeUpdateMode } from '../../../electron/shared/contract.js'
  import { getTicketStatus, setTicketStatus } from '../ipc'
  import { contentLoading, contentResolvedAt, contentRefreshNonce } from '../stores'
  import { AGENTS, agentOption } from '../agents'
  import { ReplayGate } from '../replayGate.js'
  import { decodeOsc52, writeClipboardText } from '../osc52'
  import { termKeyAction } from '../termKeys'
  import { TerminalTouchScroll, type TouchScrollHost } from '../terminalTouchScroll'
  import { findClipboardImageItem } from '../clipboardImage'
  import { closeMenusOutsideClick } from '../terminalMenus'
  import DiffView from './DiffView.svelte'
  import ChatView from './ChatView.svelte'
  import MobileTermInput from './MobileTermInput.svelte'
  import NullielLoader from './NullielLoader.svelte'
  import TerminalHeader from './TerminalHeader.svelte'
  import TerminalAlerts from './TerminalAlerts.svelte'
  import TerminalMobileActions from './TerminalMobileActions.svelte'
  import { initChatViewPref, preferChatView, setPreferChatView } from '../chatViewPrefs'

  export let session: Session

  let mountEl: HTMLDivElement
  let term: Terminal
  let fit: FitAddon
  let timer: ReturnType<typeof setTimeout> | null = null
  let askSub: IDisposable | null = null
  let osc52Sub: IDisposable | null = null
  let needsInput = false
  let alertMsg = ''

  // Unsubscribe fns for backend push listeners
  let offData: (() => void) | null = null
  let offWriteLock: (() => void) | null = null
  let offExit: (() => void) | null = null
  let onDataSub: IDisposable | null = null
  let onBinarySub: IDisposable | null = null
  // Current gate for the live session — reassigned on every resync() so the
  // long-lived onSessionData subscription (wired once in startLive) always
  // routes to the gate for the LATEST attach/snapshot round, not a stale one.
  let gate: ReplayGate | null = null
  // Set true on a transport disconnect, cleared (and triggers a resync) on
  // the next reconnect — see the onConnectionChange subscription in onMount.
  let wasDisconnected = false
  // FLO-154: writeSession bytes typed into THIS session while the transport
  // was down, buffered client-side and flushed on reconnect. Drives the
  // "will send once reconnected" banner so the buffered input reads as
  // held, not silently lost. Tracked per-session from the global
  // onPendingInputChange stream.
  let pendingInputBytes = 0
  let offPendingInput: (() => void) | null = null
  // Generation counter so overlapping resync() calls can't interleave —
  // e.g. a reconnect resync racing a scheduleLiveRetry-driven startLive().
  // Each resync resets the terminal and then (after awaits) writes a full
  // serialized snapshot; two in flight means the older one's snapshot lands
  // AFTER the newer one's reset, permanently duplicating the scrollback
  // (nothing but reset ever clears it). Only the latest generation may touch
  // the terminal — superseded calls bail after every await.
  let resyncGen = 0
  let canWrite = true
  let viewers = 1
  let exited = false
  let exitCode: number | null = null
  let restarting = false
  // FLO-110: a queued or freshly started session has no PTY snapshot yet —
  // getSessionBuffer 404s (or resync early-returns) and the view retries every
  // 1s. Until the first snapshot lands we show a Nulliel overlay instead of a
  // blank black terminal. Raised in resync() (queued branch / buffer 404),
  // cleared on snapshot success.
  let snapshotPending = false
  let handoffOpen = false
  let handingOff = false
  let updateBaseOpen = false
  let updatingBase = false
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
  let viewMode: 'terminal' | 'chat' = 'terminal'
  let chatAvailable = false
  let chatCheckedFor: string | null = null
  // Svelte runs reactive statements once during init, BEFORE onMount creates
  // `term` — and App.svelte keys this component by session id, so a fresh
  // instance mounts with a live session already selected. Gate the reactive
  // startLive/runSimulation triggers on `mounted` so they never touch the
  // terminal before it exists (TASK-GFYDO).
  let mounted = false

  $: r = repoById(session.repo)
  $: base = r?.base ?? 'base'
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

  // TASK-FPH60: the view actually rendered — chat only when both the user's
  // (or preference-seeded) viewMode says chat AND the backend has confirmed
  // chat is available for this session. Falls back to terminal whenever
  // chat can't render, so `.term-wrap` hidden, the ChatView branch, and the
  // mobile composer guard never disagree (a prior bug hid BOTH — term-wrap
  // hid on viewMode alone while the ChatView branch also required
  // chatAvailable, so a pre-first-turn session with the chat-default
  // preference rendered a blank body). The toggle button that lets a user
  // manually flip viewMode only renders once chatAvailable is already true
  // (see `{#if chatAvailable}` below), so viewMode can't be left on 'chat'
  // by a manual toggle while unavailable — it only ever gets there via the
  // initial preference seed, which means once chatAvailable later flips
  // true this recomputes to 'chat' on its own, satisfying "switch to chat
  // automatically when it becomes available and the user hasn't manually
  // chosen terminal for this session".
  $: effectiveViewMode = viewMode === 'chat' && chatAvailable ? 'chat' : 'terminal'

  function openLink(_event: MouseEvent, uri: string) {
    window.open(uri, '_blank', 'noopener,noreferrer')
  }

  // ── Touch scroll (mobile) ────────────────────────────────────────────────
  // xterm ignores touch while mouse reporting is on (coreMouseService gates
  // its own touch handling on `!areMouseEventsActive`), and driving
  // term.scrollLines() was a no-op against Claude Code anyway — it runs in
  // the alternate screen buffer, which has no scrollback (TASK-A2FY6). So
  // instead we convert pans into whole lines and dispatch one synthetic
  // per-line wheel event each, on term.element, which xterm routes exactly
  // like desktop wheel (mouse reports / arrow keys / local scroll). The
  // 'native' route is left alone — xterm's own touch scrolling is live
  // there, and dispatching wheel events too would double-scroll.
  //
  // The gesture math + routing decision live in touchScroll.ts (pure); the
  // DOM wiring/sequencing (rAF momentum loop, wheel dispatch, teardown) is
  // in terminalTouchScroll.ts's TerminalTouchScroll, driven here through a
  // TouchScrollHost bound to this component's term/mountEl/destroyed state.
  let touch: TerminalTouchScroll | null = null

  function stopMomentum() {
    touch?.stopMomentum()
  }

  function onTouchStart(e: TouchEvent) {
    touch?.onTouchStart(e)
  }

  function onTouchMove(e: TouchEvent) {
    touch?.onTouchMove(e)
  }

  function onTouchEnd(e: TouchEvent) {
    touch?.onTouchEnd(e)
  }

  function onTouchCancel() {
    touch?.onTouchCancel()
  }

  // Shared upload+^V sequencing (src/lib/imageUpload.ts) — built once from
  // this component's own ipc/stores imports (dependency injection keeps the
  // module itself DOM/backend-free and unit-testable).
  const imageUploadDeps: ImageUploadDeps = { syncClipboardImage, writeSession, markSessionInput }

  // In-flight-upload gate: pasting an image kicks off an awaited upload+^V
  // round-trip. Without this, subsequent keystrokes/Enter (term.onData/
  // onBinary, synchronous PTY passthrough) would reach the PTY before the
  // upload's ^V lands, so the CLI would submit the text alone. While an
  // upload is pending, PTY writes are buffered here and flushed in order
  // once the ^V has actually gone out.
  let pendingImageUpload: Promise<void> | null = null
  let queuedWrites: string[] = []

  // Shared by onPaste and handleFileChange below: kick off the upload+^V
  // round-trip and, once it settles (success or failure), flush whatever
  // writes queued up behind it. Callers must check `pendingImageUpload` is
  // already null before calling this (ignore a 2nd paste/pick in flight).
  function beginImageUpload(sessionId: string, blob: Blob) {
    pendingImageUpload = uploadClipboardImage(imageUploadDeps, sessionId, blob)
      .catch((err) => {
        pushToast('error', err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        const pending = queuedWrites
        queuedWrites = []
        pendingImageUpload = null
        for (const d of pending) {
          if (session.id) {
            markSessionInput(session.id)
            writeSession(session.id, d)
          }
        }
      })
  }

  function onPaste(e: ClipboardEvent) {
    if (!session.id || !canWrite) return
    const imageItem = findClipboardImageItem(e.clipboardData?.items)
    if (!imageItem) return // let text flow to xterm's own paste handling — do not interfere
    e.preventDefault()
    e.stopPropagation()
    const blob = imageItem.getAsFile()
    if (!blob) return
    if (pendingImageUpload) return // ignore a 2nd paste while one is in flight
    beginImageUpload(session.id, blob)
  }

  // Desktop attach button (header): same upload-then-^V sequencing as
  // clipboard paste, gated behind the same pendingImageUpload queue so a
  // fast-typed follow-up doesn't overtake the ^V.
  function handleFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || !session.id || !canWrite) return
    if (pendingImageUpload) return // ignore a 2nd pick while one is in flight
    beginImageUpload(session.id, file)
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
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

    term.attachCustomKeyEventHandler((ev) => termKeyAction(ev, term.hasSelection()) !== 'native')
    // Consume the OSC 52 clipboard-write sequence and write it to the local clipboard.
    // Always return true (handled) — critically this means we never answer OSC 52
    // clipboard-READ queries (payload `?`), since letting a remote agent read the
    // viewer's clipboard would be a data-exfiltration vector.
    osc52Sub = term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data)
      if (text) void writeClipboardText(text)
      return true
    })

    const touchHost: TouchScrollHost = {
      rows: () => term?.rows ?? 0,
      cellHeight: () => {
        const screen = mountEl?.querySelector<HTMLElement>('.xterm-screen')
        const rows = term?.rows ?? 0
        return screen && rows > 0 && screen.clientHeight > 0 ? screen.clientHeight / rows : 16
      },
      mouseTrackingMode: () => term.modes.mouseTrackingMode,
      bufferType: () => term.buffer.active.type,
      isDestroyed: () => destroyed,
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      elementRect: () => term.element?.getBoundingClientRect() ?? null,
      dispatchWheelLine: (deltaY, clientX, clientY) => {
        term.element?.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }),
        )
      },
    }
    touch = new TerminalTouchScroll(touchHost)
    mountEl.addEventListener('touchstart', onTouchStart, { passive: true })
    mountEl.addEventListener('touchmove', onTouchMove, { passive: false })
    mountEl.addEventListener('touchend', onTouchEnd, { passive: true })
    mountEl.addEventListener('touchcancel', onTouchCancel, { passive: true })
    mountEl.addEventListener('paste', onPaste, { capture: true })

    const onResize = () => {
      try {
        fit.fit()
      } catch {}
    }
    window.addEventListener('resize', onResize)
    const unsub = mode.subscribe(() => {
      if (term) term.options.theme = terminalTheme()
    })

    // FLO-103: after a WS reconnect the server assigns a new clientId, so the
    // old write-lock/attach state is gone and any PTY bytes emitted while we
    // were disconnected were never received — resync from scratch (attach,
    // resize, fresh snapshot) rather than leaving the terminal frozen/stale.
    const offConnection = onConnectionChange((connected) => {
      if (!connected) {
        wasDisconnected = true
        return
      }
      if (wasDisconnected) {
        wasDisconnected = false
        void resync({ force: true })
      }
    })

    // FLO-154: mirror the global per-session buffered-input map into a
    // per-view counter for THIS session, so the composer banner can show
    // "will send once reconnected" while bytes are queued and clear the
    // instant they flush on reconnect. subscribeConnectionChange already
    // drives the `connected` store used below.
    offPendingInput = onPendingInputChange((sessions) => {
      pendingInputBytes = (session.id && sessions[session.id]) || 0
    })

    mounted = true

    // TASK-FPH60: seed viewMode from the persisted global preference once it
    // resolves. Thereafter the header toggle button is the sole writer of the
    // preference; this is a one-time read on mount.
    void initChatViewPref().then(() => {
      viewMode = $preferChatView ? 'chat' : 'terminal'
    })

    return () => {
      window.removeEventListener('resize', onResize)
      unsub()
      offConnection()
      offPendingInput?.()
      offPendingInput = null
      mountEl.removeEventListener('touchstart', onTouchStart)
      mountEl.removeEventListener('touchmove', onTouchMove)
      mountEl.removeEventListener('touchend', onTouchEnd)
      mountEl.removeEventListener('touchcancel', onTouchCancel)
      mountEl.removeEventListener('paste', onPaste)
      stopMomentum()
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

  // TASK-FPH60: cheap 1-message probe purely to decide whether to show the
  // chat/terminal toggle button — ChatView.svelte does its own real 50-message
  // load independently. Clearing chatAvailable synchronously before the async
  // call resolves prevents a stale `true` from a previous session leaking into
  // the new one's render (mirrors refreshPrStatus's clear-immediately idiom).
  // Backend answers `available` for claude-code/pi/opencode sessions (false
  // for other kinds) — no kind gating needed here, the backend is the source
  // of truth. Re-probes when session.status changes and the last probe came
  // back false, since a session only becomes chat-capable once its first
  // turn/session file appears (e.g. right after launch).
  let chatCheckedStatus: string | undefined
  function refreshChatAvailability(id: string | undefined, status: string | undefined) {
    if (!hasBackend || !id) return
    const isNewSession = id !== chatCheckedFor
    if (!isNewSession) {
      if (chatAvailable) return // already known available — nothing left to probe for
      if (status === chatCheckedStatus) return // status hasn't moved since the last probe
    }
    chatCheckedFor = id
    chatCheckedStatus = status
    if (isNewSession) chatAvailable = false
    getChatMessages(id, { limit: 1 })
      .then((r) => {
        if (id === chatCheckedFor) chatAvailable = r.available
      })
      .catch(() => {
        if (id === chatCheckedFor) chatAvailable = false
      })
  }
  $: refreshChatAvailability(session.id, session.status)

  // FLO-110: reset the startup overlay when switching sessions; resync()
  // re-raises it for the queued / fresh-start-404 window. A queued session
  // shows it right away; otherwise it appears on the first buffer 404.
  let overlayForId: string | undefined
  $: if (session.id !== overlayForId) {
    overlayForId = session.id
    snapshotPending = session.status === 'queued'
  }
  $: startupCaption =
    session.status === 'queued'
      ? 'Queued — will start when a slot frees'
      : 'Creating worktree & starting agent'
  $: showStartupOverlay =
    liveMode &&
    !exited &&
    session.status !== 'errored' &&
    !showDiff &&
    effectiveViewMode === 'terminal' &&
    snapshotPending

  $: if (mounted && liveMode && session.id && session.id !== liveId) startLive()
  $: if (mounted && !liveMode && !simStarted) {
    simStarted = true
    runSimulation()
  }

  let destroyed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  onDestroy(() => {
    destroyed = true
    stopMomentum()
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    contentLoading.set(false)
    cleanupListeners()
    cleanupSimulation()
    simStarted = false
    if (session.id) detachSession(session.id)
    osc52Sub?.dispose()
    term?.dispose()
  })

  // ── Live PTY mode ─────────────────────────────────────────────────────────

  let ro: ResizeObserver | null = null
  let offResize: (() => void) | null = null
  const resumedIds = new Set<string>()

  // On a fresh start the session row only exists once the backend has
  // finished creating the worktree + spawning the PTY (sessionLauncher.ts),
  // so the very first getSessionBuffer call can 404 while that's in flight.
  // Retry (instead of a one-shot fail()) until the backend session
  // materializes, so attach/resize/write-lock wiring lands too — a one-shot
  // fail() alone would leave the client permanently view-only at 80x30.
  function scheduleLiveRetry() {
    if (retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (destroyed || exited || session.status === 'errored') return
      cleanupListeners()
      void startLive()
    }, 1000)
  }

  /**
   * (Re)attach to the live session: resume (idempotent), take the write
   * lock, resize the PTY to our size, reset the terminal, and replay a
   * fresh snapshot through a new ReplayGate. Used both by startLive() (first
   * attach) and by the onConnectionChange handler after a WS reconnect —
   * the server hands out a new clientId on reconnect, so the old write-lock
   * state is gone and any bytes emitted while we were disconnected were
   * never received, same as a fresh mount.
   */
  async function resync(opts?: { force?: boolean }) {
    if (destroyed || exited || !session.id) return
    // FLO-95: a queued session hasn't started yet — attaching/resuming would
    // be a no-op backend-side (the scheduler guards against jumping the
    // queue) and there's no PTY yet to snapshot. Poll via the existing live
    // retry loop (the same one that covers the fresh-start buffer 404) until
    // the scheduler starts it.
    if (session.status === 'queued') {
      // FLO-110: there's no PTY to snapshot yet — flag the overlay so the pane
      // reads "Queued…" instead of blank black while we poll for the start.
      snapshotPending = true
      scheduleLiveRetry()
      return
    }
    const id = session.id
    const gen = ++resyncGen

    // On a reconnect (`force`) call resumeSession regardless of resumedIds —
    // the daemon may have restarted while we were away, and resumeSession is
    // idempotent (returns the live dto if already running).
    if (opts?.force || !resumedIds.has(id)) {
      resumedIds.add(id)
      try {
        await resumeSession(id)
      } catch {
        /* already live or not found */
      }
      if (gen !== resyncGen || destroyed) return
    }

    try {
      const lock = await attachSession(id)
      if (gen !== resyncGen || destroyed) return
      canWrite = lock.canWrite
      viewers = lock.viewers
    } catch {
      if (gen !== resyncGen || destroyed) return
      // Leave the previous lock state; scheduleLiveRetry (below, on snapshot
      // failure) or the next reconnect will retry the whole sequence.
    }
    // The backend serializes the screen at the PTY's current size, so the
    // PTY must be resized to OUR size before we ask for the snapshot — this
    // also makes the agent's next repaint target the right geometry.
    try {
      fit.fit()
    } catch {}
    resizeSession(id, term.cols, term.rows)

    term.reset()
    setTimeout(() => {
      try {
        fit.fit()
      } catch {}
      // On mobile the composer input (MobileTermInput) is the typing surface;
      // focusing xterm's hidden textarea would pop the raw on-screen keyboard.
      if (!$mobile) term.focus()
    }, 40)

    const myGate = new ReplayGate((chunk) => term.write(chunk))
    gate = myGate
    try {
      const snap = await getSessionBuffer(id)
      // Superseded while the snapshot was in flight: the newer resync has
      // already reset the terminal — writing OUR full snapshot now would
      // duplicate the scrollback. Its own snapshot covers everything.
      if (gen !== resyncGen || destroyed) return
      // FLO-110: first real content landed — drop the startup overlay.
      snapshotPending = false
      myGate.applySnapshot(snap.data, snap.seq)
    } catch {
      if (gen !== resyncGen || destroyed) return
      // FLO-110: backend session hasn't materialized yet (fresh start) — keep
      // the overlay up while scheduleLiveRetry polls for it.
      snapshotPending = true
      myGate.fail()
      scheduleLiveRetry()
    }
  }

  async function startLive() {
    if (liveId !== null && liveId !== session.id) cleanupListeners()
    liveId = session.id
    exited = false
    exitCode = null

    // Clear the previous session's screen immediately on switch. resync()
    // resets again right before writing the snapshot — that's what keeps the
    // reset/snapshot pair atomic vs. concurrent resyncs — but that reset only
    // happens after its awaits, and not at all while the session is still
    // queued, so without this the old session's content would linger under
    // the new session's header.
    term.reset()

    // One-time wiring for this attach's lifetime — reused across resync()
    // calls (initial + reconnect) so we never stack duplicate listeners.
    offData = onSessionData((sid, chunk, seq) => {
      if (sid !== session.id) return
      gate?.push(chunk, seq)
    })
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
    onDataSub = term.onData((d) => {
      if (session.id && canWrite) {
        if (pendingImageUpload) {
          queuedWrites.push(d)
          return
        }
        markSessionInput(session.id)
        writeSession(session.id, d)
      }
    })
    // Mouse reports from a TUI that never enabled an extended encoding
    // (?1006h etc.) are emitted X10-encoded through onBinary, not onData —
    // without this they'd be dropped (TASK-A2FY6). Bytes ≥ 0x80 (coords past
    // column ~95) get UTF-8 mangled by the utf8 PTY write path; acceptable,
    // since snapshots restore SGR encoding and this is the legacy fallback.
    onBinarySub = term.onBinary((d) => {
      if (session.id && canWrite) {
        if (pendingImageUpload) {
          queuedWrites.push(d)
          return
        }
        markSessionInput(session.id)
        writeSession(session.id, d)
      }
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

    await resync()
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
    if (onBinarySub) {
      onBinarySub.dispose()
      onBinarySub = null
    }
    gate = null
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
      if (!$mobile) term.focus()
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
    const id = session.id
    const gen = ++resyncGen
    try {
      await attachRemoteControl(id)
      if (gen !== resyncGen || destroyed) return
      setSessionStatus(id, 'running')
      const myGate = new ReplayGate((chunk) => term.write(chunk))
      gate = myGate
      term.reset()
      const snap = await getSessionBuffer(id)
      if (gen !== resyncGen || destroyed) return
      myGate.applySnapshot(snap.data, snap.seq)
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
      if (!$mobile) term.focus()
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

  async function handleUpdateFromBase(updateMode: WorktreeUpdateMode) {
    updateBaseOpen = false
    updatingBase = true
    try {
      await updateAgentFromBase(session, updateMode)
    } finally {
      updatingBase = false
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
      if (!$mobile) term.focus()
    }, 40)
  }

  function toggleDiff() {
    showDiff = !showDiff
    if (!showDiff) refocusTerm()
  }

  function toggleViewMode() {
    const next = viewMode === 'chat' ? 'terminal' : 'chat'
    viewMode = next
    void setPreferChatView(next === 'chat')
    if (next === 'terminal') refocusTerm()
  }

  // ── Toolbar/menu toggles handed to TerminalHeader/TerminalMobileActions ──
  // Both the desktop header and the mobile action bar had their own copies of
  // these same inline toggles inline in the markup; named once here so both
  // extracted components can share the same callback.
  function toggleHandoffMenu() {
    handoffOpen = !handoffOpen
  }

  function toggleUpdateBase() {
    updateBaseOpen = !updateBaseOpen
  }

  function toggleMore() {
    moreOpen = !moreOpen
  }

  // Mobile "more" overflow menu actions: each closes the menu, then performs
  // the same action as its desktop-header counterpart (handleRemoteControl,
  // handleOpenEditor, handleUpdateFromBase) or the same plain store call
  // (run/stop/restartAppForSession) that the header's own buttons use.
  function moreOpenApp() {
    moreOpen = false
    if (appUrl) window.open(appUrl, '_blank', 'noopener,noreferrer')
  }

  function moreStopApp() {
    moreOpen = false
    stopAppForSession(session)
  }

  function moreRestartApp() {
    moreOpen = false
    restartAppForSession(session)
  }

  function moreRunApp() {
    moreOpen = false
    runAppForSession(session)
  }

  function moreRemoteControl() {
    moreOpen = false
    handleRemoteControl()
  }

  function moreOpenEditor() {
    moreOpen = false
    handleOpenEditor()
  }

  function moreUpdateFromBaseRebase() {
    moreOpen = false
    handleUpdateFromBase('rebase')
  }

  function moreUpdateFromBaseMerge() {
    moreOpen = false
    handleUpdateFromBase('merge')
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
    const next = closeMenusOutsideClick(
      { menuOpen, handoffOpen, updateBaseOpen, moreOpen },
      {
        ticketStatus: !!(t.closest('#ticketStatusSel') || t.closest('#ticketStatusSelMob')),
        handoff: !!(t.closest('#handoffSel') || t.closest('#handoffSelMob')),
        updateBase: !!t.closest('#updateBaseSel'),
        more: !!t.closest('#moreSelMob'),
      },
    )
    menuOpen = next.menuOpen
    handoffOpen = next.handoffOpen
    updateBaseOpen = next.updateBaseOpen
    moreOpen = next.moreOpen
  }

  function onTriggerClick() {
    if (!statusError && available.length > 0) menuOpen = !menuOpen
  }
</script>

<svelte:window on:click={onWindowClick} />

<TerminalHeader
  {session}
  {dot}
  {r}
  {base}
  {viewers}
  {liveMode}
  mobile={$mobile}
  {prStatus}
  {shouldShow}
  {statusLoading}
  {statusError}
  {current}
  {available}
  {menuOpen}
  {onTriggerClick}
  onSelectState={selectState}
  {showDiff}
  {pendingCommentCount}
  onToggleDiff={toggleDiff}
  {chatAvailable}
  {viewMode}
  onToggleViewMode={toggleViewMode}
  {appRunning}
  {appUrl}
  {hasBackend}
  onRunApp={() => runAppForSession(session)}
  onStopApp={() => stopAppForSession(session)}
  onRestartApp={() => restartAppForSession(session)}
  {currentKind}
  onRemoteControl={handleRemoteControl}
  {handoffOpen}
  {handoffTargets}
  {handingOff}
  onToggleHandoffMenu={toggleHandoffMenu}
  onHandoff={handleHandoff}
  {updateBaseOpen}
  {updatingBase}
  onToggleUpdateBase={toggleUpdateBase}
  onUpdateFromBase={handleUpdateFromBase}
  onOpenEditor={handleOpenEditor}
  onCleanup={handleCleanup}
  {canWrite}
  onFileChange={handleFileChange}
  onDeselect={() => select(null)}
/>

<div class="term-wrap" class:hidden={showDiff || effectiveViewMode === 'chat'}>
  <div class="term-mount" bind:this={mountEl}></div>
  {#if showStartupOverlay}
    <!-- FLO-110: covers the blank terminal while the backend creates the
         worktree / waits for a scheduler slot, mirroring the .alert overlays
         the exited / needs-input states get lower down. -->
    <div class="startup-overlay" role="status" aria-live="polite">
      <NullielLoader size={48} caption={startupCaption} />
    </div>
  {/if}
</div>

{#if showDiff}
  <DiffView {session} {canWrite} onSubmitted={handleDiffSubmitted} />
{:else if effectiveViewMode === 'chat'}
  <ChatView
    {session}
    {canWrite}
    onSwitchToTerminal={() => {
      viewMode = 'terminal'
      refocusTerm()
    }}
  />
{/if}

<TerminalAlerts
  {liveMode}
  {canWrite}
  onTakeOver={handleTakeOver}
  {needsInput}
  {alertMsg}
  {exited}
  {exitCode}
  {restarting}
  {handingOff}
  {handoffTargets}
  onRestart={handleRestart}
  onHandoff={handleHandoff}
  connected={$connected}
  {pendingInputBytes}
/>

{#if $mobile && liveMode && !exited && !showDiff && effectiveViewMode === 'terminal'}
  <!-- TerminalView is reused across sessions, so key the composer to reset its diff base on switch. -->
  {#key session.id}
    <MobileTermInput
      disabled={!canWrite}
      onData={(d) => {
        if (!session.id) return
        markSessionInput(session.id)
        writeSession(session.id, d)
      }}
      onPaste={(t) => term?.paste(t)}
      onAttachImage={session.id
        ? (blob) => uploadClipboardImage(imageUploadDeps, session.id ?? '', blob)
        : undefined}
    />
  {/key}
{/if}

{#if $mobile}
  <TerminalMobileActions
    {shouldShow}
    {statusError}
    {available}
    {current}
    {menuOpen}
    {dot}
    {onTriggerClick}
    onSelectState={selectState}
    {showDiff}
    {pendingCommentCount}
    onToggleDiff={toggleDiff}
    {chatAvailable}
    {viewMode}
    onToggleViewMode={toggleViewMode}
    {hasBackend}
    {session}
    {handoffOpen}
    {handoffTargets}
    {handingOff}
    onToggleHandoffMenu={toggleHandoffMenu}
    onHandoff={handleHandoff}
    onCleanup={handleCleanup}
    {moreOpen}
    onToggleMore={toggleMore}
    {appRunning}
    {appUrl}
    onOpenApp={moreOpenApp}
    onStopApp={moreStopApp}
    onRestartApp={moreRestartApp}
    onRunApp={moreRunApp}
    {currentKind}
    onRemoteControl={moreRemoteControl}
    onOpenEditor={moreOpenEditor}
    {base}
    {updatingBase}
    onUpdateFromBaseRebase={moreUpdateFromBaseRebase}
    onUpdateFromBaseMerge={moreUpdateFromBaseMerge}
  />
{/if}

<style>
  /* The terminal wrapper is only ever CSS-hidden (never unmounted) so xterm,
     the PTY attach, and the write-lock subscription survive toggling to the
     Diff view and back. */
  .hidden {
    display: none;
  }

  /* FLO-110: Nulliel overlay that replaces the blank terminal while a session
   * is queued or waiting on its first PTY snapshot. Anchored to .term-wrap
   * (positioned in app.css) so it covers exactly the terminal area, leaving
   * the exited / needs-input alert bars below it visible. */
  .startup-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    background: hsl(var(--background));
    animation: fade 0.2s ease-out;
  }
</style>
