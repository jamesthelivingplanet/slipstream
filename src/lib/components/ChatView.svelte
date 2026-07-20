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
  } from '../ipc'
  import { markSessionInput } from '../stores'
  import { frameForPty } from '../review.js'
  import {
    mergeChatMessages,
    buildChatView,
    type ChatViewItem,
    type ChatTextItem,
    type ChatActivityRun,
    type ChatToolActivityItem,
  } from '../chat'
  import { detectSlashToken, filterSkills, applySlashSelection } from '../chatSlash'
  import { renderMarkdown } from '../markdown'
  import { agentOption } from '../agents'
  import { floatingAnchor } from '../floating'

  export let session: Session
  export let canWrite: boolean
  export let onSwitchToTerminal: () => void

  // ── Turn grouping (renderer-only concern — buildChatView stays pure) ─────
  // A "turn" pairs an activity run with the assistant text that immediately
  // follows it (the reply the tool calls were in service of), so the turn
  // spine can visually connect them. Anything else (a lone activity run still
  // in flight, a standalone assistant text, a user message) renders as its
  // own group.
  interface TurnGroup {
    kind: 'turn'
    key: string
    activity: ChatActivityRun
    text: ChatTextItem | null
  }
  interface UserGroup {
    kind: 'user'
    key: string
    text: ChatTextItem
  }
  interface AssistantTextGroup {
    kind: 'assistant-text'
    key: string
    text: ChatTextItem
  }
  type RenderGroup = TurnGroup | UserGroup | AssistantTextGroup

  function buildRenderGroups(items: ChatViewItem[]): RenderGroup[] {
    const groups: RenderGroup[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'activity') {
        const next = items[i + 1]
        if (next && next.kind === 'text' && next.role === 'assistant') {
          groups.push({ kind: 'turn', key: `${item.turnId}:${i}`, activity: item, text: next })
          i++ // consumed the paired reply
        } else {
          groups.push({ kind: 'turn', key: `${item.turnId}:${i}`, activity: item, text: null })
        }
      } else if (item.role === 'user') {
        groups.push({ kind: 'user', key: item.uuid, text: item })
      } else {
        groups.push({ kind: 'assistant-text', key: item.uuid, text: item })
      }
    }
    return groups
  }

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
  $: renderGroups = buildRenderGroups(items)
  $: agentIcon = agentOption((session.agentKind ?? 'claude-code') as BackendKind).icon
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
    hasMore = result.messages.length >= 50
    firstLoadDone = true
    await tick()
    scrollToBottom()
  }

  // Re-fires on mount and whenever session.id changes — this component is
  // reused across session switches like TerminalView/DiffView.
  $: if (session.id && session.id !== loadedFor) {
    void loadInitial(session.id)
  }

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
    const oldestTs = messages[0].ts
    try {
      const result = await getChatMessages(sessionId, { beforeTs: oldestTs, limit: 50 })
      if (loadedFor !== sessionId) return
      const previousScrollHeight = chatBody.scrollHeight
      const previousScrollTop = chatBody.scrollTop
      messages = mergeChatMessages(messages, result.messages)
      hasMore = result.messages.length >= 50
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

  function nodeColor(item: ChatToolActivityItem): string {
    if (item.result === null) return 'hsl(var(--st-run))'
    if (item.result.isError) return 'hsl(var(--st-error))'
    return 'hsl(var(--st-done))'
  }

  async function submit() {
    const text = draftText.trim()
    if (!canWrite || !session.id || !text) return
    // Bracketed-paste the text, then send the submit key as a separate,
    // delayed write — a plain `text + '\r'` in one chunk lands in the TUI's
    // input box without submitting it (mirrors DiffView's handleSubmit).
    const { paste, submit: submitSeq } = frameForPty(text)
    markSessionInput(session.id)
    writeSession(session.id, paste)
    await new Promise((r) => setTimeout(r, 75))
    writeSession(session.id, submitSeq)
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
{:else if !available}
  <div class="chat-view chat-empty">Chat isn't available for this session.</div>
{:else}
  <div class="chat-view">
    <div class="chat-body" bind:this={chatBody} on:scroll={onScroll}>
      {#each renderGroups as group (group.key)}
        {#if group.kind === 'user'}
          <div class="user-row">
            <div class="user-bubble">{group.text.text}</div>
          </div>
        {:else if group.kind === 'assistant-text'}
          <div class="turn">
            <div class="turn-row">
              <div class="rail">
                <img class="agent-icon" src={agentIcon} width="20" height="20" alt="" />
              </div>
              <div class="row-content assistant-text">{@html renderMarkdown(group.text.text)}</div>
            </div>
          </div>
        {:else}
          <div class="turn">
            {#each group.activity.items as toolItem (toolItem.toolUseId)}
              <div class="turn-row">
                <div class="rail">
                  <span class="node" style="background:{nodeColor(toolItem)}"></span>
                </div>
                <div class="row-content">
                  <button
                    type="button"
                    class="activity-trigger"
                    aria-expanded={expandedIds.has(toolItem.toolUseId)}
                    on:click={() => toggleExpanded(toolItem.toolUseId)}
                  >
                    {toolItem.summary}
                  </button>
                  {#if expandedIds.has(toolItem.toolUseId)}
                    <div class="activity-detail">
                      <pre>{JSON.stringify(toolItem.input, null, 2)}</pre>
                      {#if toolItem.result}
                        <pre class="result" class:error={toolItem.result.isError}>{toolItem.result
                            .content}</pre>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
            {#if group.text}
              <div class="turn-row">
                <div class="rail">
                  <img class="agent-icon" src={agentIcon} width="20" height="20" alt="" />
                </div>
                <div class="row-content assistant-text">
                  {@html renderMarkdown(group.text.text)}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      {/each}

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
      <textarea
        bind:this={textareaEl}
        bind:value={draftText}
        on:keydown={onKeydown}
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
        disabled={!canWrite || !session.id || draftText.trim() === ''}
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
    padding: 2rem;
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

  /* ── user bubble ── */
  .user-row {
    display: flex;
    margin: 0.4rem 0;
  }
  .user-bubble {
    background: hsl(var(--primary) / 0.12);
    border: 1px solid hsl(var(--primary) / 0.35);
    border-radius: var(--radius);
    max-width: min(78%, 560px);
    margin-left: auto;
    padding: 0.5rem 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.85rem;
    line-height: 1.5;
  }

  /* ── assistant turn: full-width doc flow, spine in the gutter ── */
  .turn {
    display: flex;
    flex-direction: column;
    margin: 0.5rem 0;
  }
  .turn-row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
  }
  .rail {
    position: relative;
    flex: 0 0 1.75rem;
    min-height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .rail::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    background: hsl(var(--border));
    transform: translateX(-50%);
  }
  .turn-row:first-child .rail::before {
    top: 50%;
  }
  .turn-row:last-child .rail::before {
    bottom: 50%;
  }
  .node {
    position: relative;
    z-index: 1;
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .agent-icon {
    position: relative;
    z-index: 1;
    border-radius: 5px;
    object-fit: contain;
    background: hsl(var(--card));
    box-shadow: 0 0 0 3px hsl(var(--card));
  }
  .row-content {
    flex: 1;
    min-width: 0;
    padding: 0.15rem 0;
  }
  .assistant-text {
    font-size: 0.85rem;
    line-height: 1.6;
  }
  .assistant-text :global(p) {
    margin: 0.35rem 0;
  }
  .assistant-text :global(p:first-child) {
    margin-top: 0;
  }
  .assistant-text :global(p:last-child) {
    margin-bottom: 0;
  }
  .assistant-text :global(pre) {
    overflow-x: auto;
    padding: 0.5rem 0.6rem;
    border-radius: calc(var(--radius) - 3px);
    background: hsl(var(--accent-bg));
    font-family: 'Geist Mono', monospace;
    font-size: 0.78rem;
  }
  .assistant-text :global(code) {
    font-family: 'Geist Mono', monospace;
    font-size: 0.85em;
  }

  /* ── tool activity row ── */
  .activity-trigger {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-radius: calc(var(--radius) - 4px);
    font-family: 'Geist Mono', monospace;
    font-size: 0.78rem;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
  }
  .activity-trigger:hover {
    color: hsl(var(--foreground));
    background: hsl(var(--accent-bg));
  }
  @media (prefers-reduced-motion: no-preference) {
    .activity-trigger {
      transition:
        background-color 0.12s ease,
        color 0.12s ease;
    }
  }
  .activity-detail {
    padding: 0.4rem 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .activity-detail pre {
    overflow-x: auto;
    padding: 0.5rem 0.6rem;
    border-radius: calc(var(--radius) - 3px);
    background: hsl(var(--accent-bg));
    border: 1px solid hsl(var(--border));
    font-family: 'Geist Mono', monospace;
    font-size: 0.76rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .activity-detail pre.result.error {
    color: hsl(var(--st-error));
    border-color: hsl(var(--st-error) / 0.4);
    background: hsl(var(--st-error) / 0.08);
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
    font-family: 'Geist Mono', monospace;
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
    font-family: 'Geist Mono', monospace;
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
    .rail {
      flex: 0 0 1.3rem;
      min-height: 1.3rem;
    }
    .turn-row {
      gap: 0.4rem;
    }
    .chat-input-bar {
      padding: 0.6rem 0.65rem;
      padding-bottom: max(0.6rem, env(safe-area-inset-bottom));
    }
    .user-bubble {
      max-width: 88%;
    }
  }
</style>
