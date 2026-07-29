<script context="module" lang="ts">
  import type { AgentSkillDTO as CachedAgentSkillDTO } from '../../../electron/shared/contract.js'

  // Module-level (survives ChatView mount/destroy, e.g. toggling to Terminal
  // and back) skills cache keyed by session id — "fetch lazily on first open,
  // cache per session" (TASK-FPH60).
  const skillsCache = new Map<string, CachedAgentSkillDTO[]>()

  // Module-level per-session draft cache — survives ChatView mount/destroy
  // (session switch, or toggling to Terminal and back), so an in-progress
  // draft message isn't silently lost.
  const draftCache = new Map<string, string>()
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import type { Session, BackendKind } from '../types'
  import type {
    SessionChatMessageDTO,
    AgentSkillDTO,
    ChatQuestionDTO,
  } from '../../../electron/shared/contract.js'
  import {
    getChatMessages,
    onChatMessage,
    writeSession,
    hasBackend,
    subscribeChat,
    unsubscribeChat,
    listAgentSkills,
    getChatQuestion,
    syncClipboardImage,
  } from '../ipc'
  import { markSessionInput } from '../stores'
  import { frameForPty } from '../review.js'
  import {
    mergeChatMessages,
    buildChatView,
    buildSubagentGroups,
    chatEmptyState,
    mainlineStats,
  } from '../chat'
  import { detectSlashToken, filterSkills, applySlashSelection } from '../chatSlash'
  import { agentOption } from '../agents'
  import { floatingAnchor } from '../floating'
  import { icons } from '../icons'
  import { uploadClipboardImage, type ImageUploadDeps } from '../imageUpload'
  import { pushToast } from '../toast'
  import ChatTurnList from './ChatTurnList.svelte'

  export let session: Session
  export let canWrite: boolean
  export let onSwitchToTerminal: () => void

  let chatBody: HTMLDivElement
  let messages: SessionChatMessageDTO[] = []
  let loadedFor: string | null = null
  let available = true
  let firstLoadDone = false
  let hasMore = true
  let loadingOlder = false
  let atBottom = true
  let expandedIds = new Set<string>()
  let draftText = ''
  // The session id draftText's current value belongs to — used to persist it
  // into draftCache per-session and restore it on session switch (TASK-5E5CY).
  let draftSessionId: string | null = null
  let offChatMessage: (() => void) | null = null
  let textareaEl: HTMLTextAreaElement
  let inputBarEl: HTMLDivElement

  // ── Image attach/paste (TASK-6R28O) ───────────────────────────────────────
  const imageUploadDeps: ImageUploadDeps = { syncClipboardImage, writeSession, markSessionInput }
  let fileInput: HTMLInputElement
  let stagedImage: { blob: Blob; previewUrl: string } | null = null

  function handleFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) {
      if (stagedImage) URL.revokeObjectURL(stagedImage.previewUrl)
      stagedImage = { blob: file, previewUrl: URL.createObjectURL(file) }
    }
    input.value = ''
  }

  function removeStagedImage() {
    if (!stagedImage) return
    URL.revokeObjectURL(stagedImage.previewUrl)
    stagedImage = null
  }

  function handleImagePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (items) {
      for (const item of items) {
        // DataTransferItem.kind is only ever 'string' or 'file' per spec — an
        // image on the clipboard surfaces as kind 'file' with an image/*
        // type, never kind 'image' (there is no such kind).
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const blob = item.getAsFile()
          if (blob) {
            e.preventDefault()
            if (stagedImage) URL.revokeObjectURL(stagedImage.previewUrl)
            stagedImage = { blob, previewUrl: URL.createObjectURL(blob) }
            return
          }
          break
        }
      }
    }
    // else: let normal text paste flow into the textarea untouched.
  }

  // ── Needs-input question (TASK-FPH60) ─────────────────────────────────────
  // What the agent is actually asking, shown inside the needs-card instead of
  // the generic "Claude is asking something in the terminal" wording.
  let chatQuestion: ChatQuestionDTO | null = null
  // Bumped on every fetch start/clear so a stale in-flight response can't
  // clobber a newer one (mirrors loadInitial's loadedFor guard).
  let questionFetchSeq = 0
  // needsSince is episode-scoped (stores.ts) — keying the "have we fetched
  // for this episode" check on it (rather than just session.id) re-fetches
  // exactly once per needs episode, including the very first render when
  // mounting straight into an already-'needs' session.
  let questionFetchedFor: string | null = null

  // Retries because getChatQuestion is gated on the backend's own
  // instantaneous session status, which flaps needs↔running on an idle TUI
  // (status pings on every PTY chunk, not on change — see docs/ARCHITECTURE.md
  // §Session status pipeline). A single fetch can land in a momentary
  // 'running' flap and come back null even though the episode (needsSince)
  // is still live, so we poll a few times before giving up. Never clobbers an
  // already-fetched good question with a later null.
  async function fetchChatQuestion(sessionId: string, episodeSince: number) {
    const seq = ++questionFetchSeq
    for (let i = 0; i < 8; i++) {
      let result: ChatQuestionDTO | null
      try {
        result = await getChatQuestion(sessionId)
      } catch {
        result = null
      }
      if (seq !== questionFetchSeq || session.id !== sessionId) return // superseded
      if (result) {
        chatQuestion = result
        return
      }
      if (session.needsSince !== episodeSince) return // episode ended/changed
      await new Promise((r) => setTimeout(r, 1200))
      if (seq !== questionFetchSeq || session.id !== sessionId) return // superseded
    }
  }

  // Re-fetch once per needs episode (on mount if already in one, and again
  // whenever a fresh episode starts); clear the instant the episode ends
  // (needsSince clears) so a stale question never lingers into the next
  // episode. Gated on needsSince (episode-scoped, stamped once) rather than
  // the flappy instantaneous session.status. A plain function (not inline in
  // the $: block below) — mirrors refreshChatAvailability in
  // TerminalView.svelte, which avoids eslint-plugin-svelte flagging the
  // synchronous state writes as a possible infinite reactive loop.
  function syncChatQuestion(id: string | undefined, needsSince: number | undefined) {
    if (id && needsSince != null) {
      const episodeKey = `${id}:${needsSince}`
      if (questionFetchedFor !== episodeKey) {
        questionFetchedFor = episodeKey
        void fetchChatQuestion(id, needsSince)
      }
    } else if (chatQuestion !== null || questionFetchedFor !== null) {
      questionFetchSeq++ // invalidate any in-flight fetch from the episode just left
      questionFetchedFor = null
      chatQuestion = null
    }
  }

  // ── Slash-command skills menu ─────────────────────────────────────────────
  let skills: AgentSkillDTO[] = []
  let skillsLoadedFor: string | null = null
  let highlightedIndex = 0
  // The exact draft text the menu was dismissed for (Esc) — typing further
  // (which changes draftText) re-opens it, matching how the token itself
  // only exists while draftText hasn't moved past it.
  let dismissedDraft: string | null = null

  $: items = buildChatView(messages)
  // Subagent turns (isSidechain: true) nested under the Agent tool_use that
  // spawned them (TASK-N6X4R Task 3) — computed alongside `items` from the
  // same raw `messages`, since buildSubagentGroups needs both (the raw
  // messages to find sidechain turns, and `items` to cross-reference which
  // Agent tool_use ids actually landed in this loaded page).
  $: subagents = buildSubagentGroups(messages, items)
  $: agent = agentOption((session.agentKind ?? 'claude-code') as BackendKind)
  $: agentIcon = agent.icon
  // Whether this kind has a chat transcript reader at all (TASK-N6X4R) — see
  // chatEmptyState in ../chat.ts for why this, not `available` alone, decides
  // the empty-state copy.
  $: chatSupported = agent.supportsChat
  $: emptyState = chatEmptyState(chatSupported, available, messages.length > 0)

  // Chat can never populate for a kind with no reader — skip the useless
  // fetch (the backend would just answer `available:false` anyway) and show
  // the "not available" state immediately instead of flashing "Loading
  // messages…" first. Ideally we don't even land here: TerminalView only
  // mounts ChatView once its own `chatAvailable` probe has confirmed
  // availability, which never happens for these kinds — this is a
  // belt-and-suspenders guard for whenever that isn't true (e.g. ChatView
  // reused elsewhere, or a probe race). A plain function (not inlined in the
  // `$:` block) — mirrors refreshChatAvailability in TerminalView.svelte,
  // which avoids eslint-plugin-svelte flagging the synchronous state writes
  // as a possible infinite reactive loop.
  function beginLoad(sessionId: string, supportsChat: boolean) {
    if (supportsChat) {
      void loadInitial(sessionId)
    } else {
      loadedFor = sessionId
      messages = []
      available = false
      hasMore = false
      firstLoadDone = true
    }
  }
  $: if (session.id && session.id !== loadedFor) beginLoad(session.id, chatSupported)

  // Steer the user straight to the terminal rather than leaving them on a
  // chat pane that can never show anything — fires once per mount (this
  // component is recreated per session switch, see the onMount comment
  // below on the subscribeChat call).
  let autoSwitchedToTerminal = false
  function switchToTerminalOnce() {
    if (autoSwitchedToTerminal) return
    autoSwitchedToTerminal = true
    onSwitchToTerminal()
  }
  $: if (emptyState === 'unsupported') switchToTerminalOnce()

  $: showNeedsCard =
    session.needsSince != null && !messages.some((m) => m.ts >= (session.needsSince as number))
  $: writeDisabledReason = !canWrite ? 'Another client controls this session.' : ''
  $: syncChatQuestion(session.id, session.needsSince)

  $: slashToken = detectSlashToken(draftText)
  $: if (slashToken && session.id) void ensureSkillsLoaded(session.id)
  $: slashResults = slashToken ? filterSkills(skills, slashToken.query) : []
  $: slashMenuOpen = !!slashToken && slashResults.length > 0 && draftText !== dismissedDraft
  $: if (slashMenuOpen) highlightedIndex = Math.min(highlightedIndex, slashResults.length - 1)

  async function ensureSkillsLoaded(sessionId: string) {
    const cached = skillsCache.get(sessionId)
    if (cached) {
      skills = cached
      skillsLoadedFor = sessionId
      return
    }
    if (skillsLoadedFor === sessionId) return // fetch already in flight for this session
    skillsLoadedFor = sessionId
    try {
      const result = await listAgentSkills(sessionId)
      if (session.id !== sessionId) return // superseded by a session switch
      skillsCache.set(sessionId, result)
      skills = result
    } catch {
      if (session.id !== sessionId) return
      skillsLoadedFor = null // allow a retry on the next '/' open
      skills = []
    }
  }

  function selectSkill(skill: AgentSkillDTO) {
    if (!slashToken) return
    draftText = applySlashSelection(draftText, slashToken, skill.name)
    void tick().then(() => textareaEl?.focus())
  }

  function scrollToBottom() {
    if (chatBody) chatBody.scrollTop = chatBody.scrollHeight
  }

  async function loadInitial(sessionId: string) {
    loadedFor = sessionId
    messages = []
    available = true
    hasMore = true
    firstLoadDone = false
    let result: { available: boolean; messages: SessionChatMessageDTO[] }
    try {
      result = await getChatMessages(sessionId, { limit: 50 })
    } catch {
      result = { available: false, messages: [] }
    }
    if (loadedFor !== sessionId) return // superseded by another session switch
    available = result.available
    messages = mergeChatMessages([], result.messages)
    // Count only main-thread messages — a page's subagent messages ride
    // along on top of `limit` (TASK-N6X4R), so `result.messages.length` alone
    // would almost always read >= 50 and never stop offering "load older".
    hasMore = mainlineStats(result.messages).mainCount >= 50
    firstLoadDone = true
    await tick()
    scrollToBottom()
  }

  // Re-fires on mount and whenever session.id changes — this component is
  // reused across session switches like TerminalView/DiffView. (Guarded on
  // chatSupported up near that flag's definition, above.)

  // Per-session draft persistence (TASK-5E5CY): restore the saved draft the
  // moment session.id changes to one we haven't already switched to — this
  // must run (and settle draftSessionId/draftText) before the persist
  // reactive below so typing after a switch doesn't immediately stomp the
  // cache with a mid-restore value. On the very next session switch it also
  // fires before the persist reactive re-runs for the new session, so no
  // draft is ever attributed to the wrong session.
  $: if (session.id && session.id !== draftSessionId) {
    draftSessionId = session.id
    draftText = draftCache.get(session.id) ?? ''
  }

  // Persist every keystroke into the module-level cache so the draft
  // survives this component being destroyed (session switch, or toggling to
  // Terminal and back).
  $: if (draftSessionId) draftCache.set(draftSessionId, draftText)

  async function loadOlder() {
    if (loadingOlder || !hasMore || !session.id || messages.length === 0) return
    const sessionId = session.id
    loadingOlder = true
    // A subagent runs during its spawning turn, so its own timestamps can
    // precede that turn's — paginating from messages[0].ts (which may be a
    // sidechain message) can skip main-thread messages or stall pagination.
    // Fall back to messages[0].ts only in the (not normally expected) case
    // where the loaded list has no main-thread message at all.
    const oldestTs = mainlineStats(messages).oldestMainTs ?? messages[0].ts
    try {
      const result = await getChatMessages(sessionId, { beforeTs: oldestTs, limit: 50 })
      if (loadedFor !== sessionId) return
      const previousScrollHeight = chatBody.scrollHeight
      const previousScrollTop = chatBody.scrollTop
      messages = mergeChatMessages(messages, result.messages)
      // See loadInitial — count only main-thread messages when deciding
      // whether a full page came back (TASK-N6X4R).
      hasMore = mainlineStats(result.messages).mainCount >= 50
      await tick()
      chatBody.scrollTop = chatBody.scrollHeight - previousScrollHeight + previousScrollTop
    } catch {
      // leave hasMore as-is; the next scroll-to-top retries
    } finally {
      loadingOlder = false
    }
  }

  function onScroll() {
    if (!chatBody) return
    atBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 40
    if (chatBody.scrollTop < 80 && hasMore && !loadingOlder) {
      void loadOlder()
    }
  }

  onMount(() => {
    offChatMessage = onChatMessage((id, msg) => {
      if (id !== session.id) return
      const wasAtBottom = atBottom
      messages = mergeChatMessages(messages, [msg])
      if (wasAtBottom) {
        void tick().then(scrollToBottom)
      }
    })
    // Registers this client as a subscriber so opencode's server-side polling
    // runs while the chat view is open (claude/pi tails don't need it — the
    // call is harmless for them). This component is keyed/remounted per
    // session (see TerminalView's {#key session.id}), so mount/destroy here
    // line up 1:1 with a single session.id.
    if (hasBackend && session.id) void subscribeChat(session.id)
  })

  onDestroy(() => {
    offChatMessage?.()
    if (hasBackend && session.id) void unsubscribeChat(session.id)
    // Belt-and-suspenders: the persist reactive already keeps draftCache
    // current, but save once more in case destroy fires before Svelte flushes
    // a final reactive pass.
    if (draftSessionId) draftCache.set(draftSessionId, draftText)
  })

  function toggleExpanded(toolUseId: string) {
    const next = new Set(expandedIds)
    if (next.has(toolUseId)) next.delete(toolUseId)
    else next.add(toolUseId)
    expandedIds = next
  }

  async function submit() {
    const text = draftText.trim()
    if (!canWrite || !session.id) return
    if (!text && !stagedImage) return // allow image-only send
    if (stagedImage) {
      const blob = stagedImage.blob
      URL.revokeObjectURL(stagedImage.previewUrl)
      stagedImage = null
      try {
        await uploadClipboardImage(imageUploadDeps, session.id, blob)
      } catch (err) {
        pushToast('error', err instanceof Error ? err.message : String(err))
      }
    }
    if (text) {
      // Bracketed-paste the text, then send the submit key as a separate,
      // delayed write — a plain `text + '\r'` in one chunk lands in the TUI's
      // input box without submitting it (mirrors DiffView's handleSubmit).
      const { paste, submit: submitSeq } = frameForPty(text)
      markSessionInput(session.id)
      writeSession(session.id, paste)
      await new Promise((r) => setTimeout(r, 75))
      writeSession(session.id, submitSeq)
    } else {
      // Image-only send: the ^V already inserted the image ref; submit it.
      markSessionInput(session.id)
      writeSession(session.id, '\r')
    }
    draftText = ''
  }

  function onKeydown(e: KeyboardEvent) {
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        highlightedIndex = (highlightedIndex + 1) % slashResults.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        highlightedIndex = (highlightedIndex - 1 + slashResults.length) % slashResults.length
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        selectSkill(slashResults[highlightedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissedDraft = draftText
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }
</script>

{#if !firstLoadDone}
  <div class="chat-view chat-empty">Loading messages…</div>
{:else if emptyState === 'unsupported'}
  <!-- TASK-N6X4R: this kind has no chat reader (supportsChat:false) — chat can
       NEVER populate, so never invite a message here. autoSwitchedToTerminal
       above already steers away; this button covers the case that doesn't
       (e.g. onSwitchToTerminal is a no-op in some host). -->
  <div class="chat-view chat-empty">
    <p>{agent.label} doesn't have a chat view — its output only shows in the terminal.</p>
    <button type="button" class="btn btn-outline btn-sm" on:click={onSwitchToTerminal}>
      Switch to terminal
    </button>
  </div>
{:else if emptyState === 'waiting'}
  <!-- Chat-capable, but nothing recoverable yet (transcript not written, server
       not up) — a waiting message, not an invitation to type. -->
  <div class="chat-view chat-empty">Waiting for chat to become available…</div>
{:else}
  <div class="chat-view">
    <div class="chat-body" bind:this={chatBody} on:scroll={onScroll}>
      {#if emptyState === 'empty'}
        <div class="chat-empty-inline">No messages yet — start the conversation below.</div>
      {/if}
      <ChatTurnList
        {items}
        {agentIcon}
        {expandedIds}
        {toggleExpanded}
        subagentsByToolUseId={subagents.byToolUseId}
      />

      {#if subagents.orphaned.length > 0}
        <!-- TASK-N6X4R Task 3: subagent transcript whose spawning Agent
             tool_use isn't in this loaded page (or had no parentUuid at all)
             — degrade gracefully rather than dropping the content: show it
             grouped, clearly labeled, collapsed by default. Chronological
             placement isn't meaningful here (that's the whole reason it's
             orphaned), so these render together after the main transcript. -->
        <div class="subagent-orphaned-section">
          {#each subagents.orphaned as group (group.id)}
            {@const key = `orphan:${group.id}`}
            {@const label = group.label ?? group.agentType ?? 'Subagent work (unmatched)'}
            <button
              type="button"
              class="subagent-orphan-trigger"
              class:expanded={expandedIds.has(key)}
              aria-expanded={expandedIds.has(key)}
              title={label}
              on:click={() => toggleExpanded(key)}
            >
              <span class="trigger-label">{label}</span>
              {#if group.label && group.agentType}
                <span class="subagent-type-chip">{group.agentType}</span>
              {/if}
              <span class="subagent-orphan-badge"
                >{group.turnCount} {group.turnCount === 1 ? 'turn' : 'turns'}</span
              >
            </button>
            {#if expandedIds.has(key)}
              <div class="subagent-orphan-body">
                <ChatTurnList
                  items={group.items}
                  {agentIcon}
                  {expandedIds}
                  {toggleExpanded}
                  subagentsByToolUseId={subagents.byToolUseId}
                  nested={true}
                />
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if showNeedsCard}
        <div class="needs-card">
          {#if chatQuestion}
            <div class="needs-question">
              <div class="needs-question-label">
                {chatQuestion.source === 'agent' ? 'Claude asks:' : 'From the terminal:'}
              </div>
              <pre class="needs-question-text">{chatQuestion.text}</pre>
            </div>
          {:else}
            <div class="needs-text">Claude is asking something in the terminal</div>
          {/if}
          <button type="button" class="btn btn-outline btn-sm" on:click={onSwitchToTerminal}>
            Switch to terminal
          </button>
        </div>
      {/if}
    </div>

    {#if stagedImage}
      <div class="term-attach-preview">
        <button
          type="button"
          class="term-attach-thumb"
          aria-label="Remove attached image"
          on:click={removeStagedImage}
        >
          <img src={stagedImage.previewUrl} alt="Attached preview" />
          <span class="term-attach-thumb-remove">{@html icons.close}</span>
        </button>
      </div>
    {/if}
    <div class="chat-input-bar" bind:this={inputBarEl}>
      {#if slashMenuOpen}
        <div
          id="slash-listbox"
          class="sel-menu slash-menu"
          role="listbox"
          aria-label="Skills"
          use:floatingAnchor={{ to: inputBarEl, gap: 6 }}
        >
          {#each slashResults as skill, i (skill.name)}
            <button
              type="button"
              id={`slash-opt-${i}`}
              class="opt slash-opt"
              class:sel={i === highlightedIndex}
              role="option"
              aria-selected={i === highlightedIndex}
              on:mousedown|preventDefault
              on:click={() => selectSkill(skill)}
            >
              <span class="slash-name">/{skill.name}</span>
              <span class="slash-desc">{skill.description}</span>
              {#if skill.source === 'user'}
                <span class="slash-src">user</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        style="display:none"
        on:change={handleFileChange}
      />
      <button
        type="button"
        class="btn btn-outline term-attach"
        title="Attach image"
        aria-label="Attach image"
        disabled={!canWrite || !session.id}
        on:click={() => fileInput.click()}
      >
        {@html icons.image}
      </button>
      <textarea
        bind:this={textareaEl}
        bind:value={draftText}
        on:keydown={onKeydown}
        on:paste={handleImagePaste}
        disabled={!canWrite || !session.id}
        placeholder={writeDisabledReason || 'Message the agent…'}
        rows="2"
        role="combobox"
        aria-expanded={slashMenuOpen}
        aria-controls="slash-listbox"
        aria-activedescendant={slashMenuOpen ? `slash-opt-${highlightedIndex}` : undefined}
      ></textarea>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        disabled={!canWrite || !session.id || (draftText.trim() === '' && !stagedImage)}
        on:click={submit}
      >
        Send
      </button>
    </div>
    {#if writeDisabledReason}
      <div class="chat-lock-note">{writeDisabledReason}</div>
    {/if}
  </div>
{/if}

<style>
  .chat-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .chat-empty {
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.85rem;
    text-align: center;
  }
  .chat-empty p {
    margin: 0;
    max-width: 32rem;
  }
  /* Genuinely-empty conversation (TASK-N6X4R): shown inline above the input
     bar, not as a full-pane replacement, so "start the conversation below"
     still points at something visible. */
  .chat-empty-inline {
    margin: auto 0;
    padding: 2rem 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.85rem;
    text-align: center;
  }

  .chat-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
  }

  /* ── orphaned subagent work (TASK-N6X4R Task 3) — a sidechain group whose
     spawning Agent tool_use isn't in this loaded page (or had no parentUuid
     at all). Same trigger/badge language as ChatTurnList's attached-subagent
     row (kept as a separate, unscoped copy here since Svelte's per-component
     style scoping means ChatTurnList's `<style>` doesn't reach markup written
     directly in this file), so it reads consistently whichever case applies. */
  .subagent-orphaned-section {
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px dashed hsl(var(--border));
  }
  .subagent-orphan-trigger {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-radius: calc(var(--radius) - 4px);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
  }
  .subagent-orphan-trigger:hover {
    color: hsl(var(--foreground));
    background: hsl(var(--accent-bg));
  }
  /* Collapsed: one line, clipped with an ellipsis (TASK-1V8H8, same treatment
     as ChatTurnList's .activity-trigger — kept as its own copy here since
     Svelte's per-component style scoping doesn't reach across files).
     Expanded (.expanded): let it wrap and show the full label. */
  .subagent-orphan-trigger .trigger-label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subagent-orphan-trigger.expanded .trigger-label {
    white-space: normal;
    overflow: visible;
    text-overflow: unset;
  }
  .subagent-orphan-trigger .subagent-type-chip {
    flex: 0 0 auto;
    font-size: 0.68rem;
    color: hsl(var(--muted-foreground));
    background: hsl(var(--muted-foreground) / 0.1);
    border-radius: calc(var(--radius) - 4px);
    padding: 0 0.35rem;
  }
  .subagent-orphan-badge {
    flex: 0 0 auto;
    font-size: 0.7rem;
    color: hsl(var(--muted-foreground));
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) - 4px);
    padding: 0 0.35rem;
  }
  .subagent-orphan-body {
    margin-left: 0.15rem;
    padding: 0.4rem 0 0.4rem 0.7rem;
    border-left: 2px solid hsl(var(--border));
    background: hsl(var(--muted-foreground) / 0.04);
    border-radius: 0 calc(var(--radius) - 3px) calc(var(--radius) - 3px) 0;
  }

  /* ── needs-input fallback card ── */
  .needs-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.6rem;
    margin-top: 0.6rem;
    padding: 0.7rem 0.85rem;
    border-radius: var(--radius);
    color: hsl(var(--st-needs));
    border: 1px solid hsl(var(--st-needs) / 0.4);
    background: hsl(var(--st-needs) / 0.08);
    font-size: 0.82rem;
  }
  .needs-card > .btn {
    align-self: flex-start;
  }
  .needs-text {
    flex: 1;
  }
  .needs-question {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .needs-question-label {
    font-weight: 600;
  }
  .needs-question-text {
    margin: 0;
    max-height: 14rem;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    line-height: 1.5;
    color: hsl(var(--foreground));
    padding: 0.5rem 0.6rem;
    border-radius: calc(var(--radius) - 3px);
    background: hsl(var(--accent-bg));
    border: 1px solid hsl(var(--st-needs) / 0.25);
  }

  /* ── input bar ── */
  .chat-input-bar {
    flex: 0 0 auto;
    display: flex;
    gap: 0.6rem;
    align-items: flex-end;
    padding: 0.7rem 1rem;
    padding-bottom: max(0.7rem, env(safe-area-inset-bottom));
    border-top: 1px solid hsl(var(--border));
    background: hsl(var(--background));
  }
  .chat-input-bar textarea {
    flex: 1;
    resize: none;
    min-height: 2.5rem;
    max-height: 8rem;
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius);
    border: 1px solid hsl(var(--input));
    background: hsl(var(--background));
    color: inherit;
    font-family: inherit;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .chat-input-bar textarea:focus-visible {
    outline: none;
    border-color: hsl(var(--ring));
  }
  .chat-input-bar textarea:disabled {
    opacity: 0.5;
  }
  /* Attach button: sized to match this bar's .btn-sm (30px tall) siblings. */
  .term-attach {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    padding: 0;
    justify-content: center;
  }
  /* Staged-image preview strip: sits directly above .chat-input-bar. */
  .term-attach-preview {
    flex: 0 0 auto;
    display: flex;
    padding: 0.5rem 1rem 0;
    background: hsl(var(--background));
  }
  .term-attach-thumb {
    position: relative;
    width: 56px;
    height: 56px;
    padding: 0;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    overflow: hidden;
    background: none;
    cursor: pointer;
  }
  .term-attach-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .term-attach-thumb-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: hsl(var(--background) / 0.85);
    color: hsl(var(--foreground));
  }
  .chat-lock-note {
    flex: 0 0 auto;
    padding: 0 1rem 0.6rem;
    font-size: 0.75rem;
    color: hsl(var(--muted-foreground));
  }

  /* ── slash-command skills menu ── */
  .slash-opt {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    position: relative;
  }
  .slash-opt.sel {
    background: hsl(var(--accent-bg));
  }
  .slash-name {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
  }
  .slash-desc {
    font-size: 0.75rem;
    color: hsl(var(--muted-foreground));
    white-space: normal;
  }
  .slash-src {
    position: absolute;
    top: 8px;
    right: 10px;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: hsl(var(--muted-foreground));
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) - 4px);
    padding: 1px 5px;
  }

  :focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }

  @media (max-width: 700px) {
    .chat-body {
      padding: 0.6rem 0.65rem;
    }
    .chat-input-bar {
      padding: 0.6rem 0.65rem;
      padding-bottom: max(0.6rem, env(safe-area-inset-bottom));
    }
  }
</style>
