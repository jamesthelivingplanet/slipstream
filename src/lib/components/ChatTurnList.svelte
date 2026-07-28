<script lang="ts">
  // Renders one ordered ChatViewItem[] as the visual transcript: user bubbles,
  // assistant text/thinking, tool activity runs (with Edit/Write diffs and
  // TodoWrite checklists), and images. Extracted from ChatView.svelte
  // (TASK-N6X4R) so the same ~80 lines of markup can be instantiated both at
  // the top level (the main transcript) and recursively — via <svelte:self> —
  // inside an expanded `Agent` tool_use row, to show a nested subagent's own
  // transcript without duplicating this template.
  //
  // Turn grouping (renderer-only concern — buildChatView in ../chat.ts stays
  // pure) lives here rather than in chat.ts: a "turn" pairs an activity run
  // with the assistant text that immediately follows it (the reply the tool
  // calls were in service of), so the turn spine can visually connect them.
  // Anything else (a lone activity run still in flight, a standalone
  // assistant text/thinking/image, a user message) renders as its own group.
  import type {
    ChatViewItem,
    ChatTextItem,
    ChatThinkingItem,
    ChatImageItem,
    ChatActivityRun,
    ChatToolActivityItem,
    ChatSubagentGroup,
  } from '../chat'
  import { toolEditHunks, toolWriteHunks, toolTodos } from '../chat'
  import { renderMarkdown } from '../markdown'
  import { icons } from '../icons'
  import DiffHunks from './DiffHunks.svelte'

  export let items: ChatViewItem[]
  export let agentIcon: string
  // Shared across every instance in the tree (top-level + nested via
  // svelte:self) — owned by the top-level caller (ChatView.svelte) and passed
  // straight through, so expanding a row anywhere re-renders the whole tree
  // via the usual Svelte prop reactivity rather than each instance keeping
  // its own disconnected copy.
  export let expandedIds: Set<string>
  export let toggleExpanded: (id: string) => void
  // Attached subagent groups keyed by the toolUseId of the `Agent` tool_use
  // that spawned them (TASK-N6X4R Task 3) — only meaningful for the
  // top-level (main-transcript) instance; a nested instance rendering a
  // subagent's own transcript is passed an empty map (no support for
  // recursively nesting a subagent's own further subagent calls — an `Agent`
  // tool_use inside a subagent transcript still renders, just as a plain
  // collapsed tool call with the generic JSON detail, degrading gracefully).
  export let subagentsByToolUseId: Map<string, ChatSubagentGroup> = new Map()
  // True for a nested (subagent) instance — drives the "someone else's work,
  // not primary conversation" visual treatment (indent, left border, muted).
  export let nested = false

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
  interface ThinkingGroup {
    kind: 'thinking'
    key: string
    item: ChatThinkingItem
  }
  interface ImageGroup {
    kind: 'image'
    key: string
    item: ChatImageItem
  }
  type RenderGroup = TurnGroup | UserGroup | AssistantTextGroup | ThinkingGroup | ImageGroup

  function buildRenderGroups(viewItems: ChatViewItem[]): RenderGroup[] {
    const groups: RenderGroup[] = []
    for (let i = 0; i < viewItems.length; i++) {
      const item = viewItems[i]
      if (item.kind === 'activity') {
        const next = viewItems[i + 1]
        if (next && next.kind === 'text' && next.role === 'assistant') {
          groups.push({ kind: 'turn', key: `${item.turnId}:${i}`, activity: item, text: next })
          i++ // consumed the paired reply
        } else {
          groups.push({ kind: 'turn', key: `${item.turnId}:${i}`, activity: item, text: null })
        }
      } else if (item.kind === 'thinking') {
        groups.push({ kind: 'thinking', key: item.uuid, item })
      } else if (item.kind === 'image') {
        groups.push({ kind: 'image', key: item.uuid, item })
      } else if (item.role === 'user') {
        groups.push({ kind: 'user', key: item.uuid, text: item })
      } else {
        groups.push({ kind: 'assistant-text', key: item.uuid, text: item })
      }
    }
    return groups
  }

  $: renderGroups = buildRenderGroups(items)

  function nodeColor(item: ChatToolActivityItem): string {
    if (item.result === null) return 'hsl(var(--st-run))'
    if (item.result.isError) return 'hsl(var(--st-error))'
    return 'hsl(var(--st-done))'
  }

  // ── TASK-N6X4R: real rendering for Edit/Write/TodoWrite instead of the
  // generic JSON dump. Both wrap the pure chat.ts parsers, which return null
  // on any shape mismatch — the template falls back to the JSON dump below
  // whenever that happens, for any tool.
  function toolDiffHunks(item: ChatToolActivityItem) {
    if (item.name === 'Edit') return toolEditHunks(item.input)
    if (item.name === 'Write') return toolWriteHunks(item.input)
    return null
  }

  function todoStatusColor(status: 'pending' | 'in_progress' | 'completed'): string {
    if (status === 'completed') return 'hsl(var(--st-done))'
    if (status === 'in_progress') return 'hsl(var(--st-run))'
    return 'hsl(var(--muted-foreground))'
  }
</script>

<div class="turn-list" class:nested>
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
    {:else if group.kind === 'thinking'}
      <!-- TASK-N6X4R: collapsed-by-default, muted — must never visually
           compete with the assistant's actual reply. -->
      <div class="turn">
        <div class="turn-row">
          <div class="rail">
            <span class="node thinking-node"></span>
          </div>
          <div class="row-content">
            <button
              type="button"
              class="thinking-trigger"
              aria-expanded={expandedIds.has(group.item.uuid)}
              on:click={() => toggleExpanded(group.item.uuid)}
            >
              Thinking
            </button>
            {#if expandedIds.has(group.item.uuid)}
              <div class="activity-detail">
                <pre class="thinking-text">{group.item.text}</pre>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {:else if group.kind === 'image'}
      <div class="turn">
        <div class="turn-row">
          <div class="rail">
            {#if group.item.role === 'assistant'}
              <img class="agent-icon" src={agentIcon} width="20" height="20" alt="" />
            {:else}
              <span class="node" style="background:hsl(var(--st-done))"></span>
            {/if}
          </div>
          <div class="row-content">
            <img
              class="chat-image"
              src={`data:${group.item.mediaType};base64,${group.item.data}`}
              alt="Attached"
            />
          </div>
        </div>
      </div>
    {:else}
      <div class="turn">
        {#each group.activity.items as toolItem (toolItem.toolUseId)}
          {@const attachedSubagent =
            toolItem.name === 'Agent' ? subagentsByToolUseId.get(toolItem.toolUseId) : undefined}
          <div class="turn-row">
            <div class="rail">
              <span class="node" style="background:{nodeColor(toolItem)}"></span>
            </div>
            <div class="row-content">
              <button
                type="button"
                class="activity-trigger"
                class:subagent-trigger={!!attachedSubagent}
                aria-expanded={expandedIds.has(toolItem.toolUseId)}
                on:click={() => toggleExpanded(toolItem.toolUseId)}
              >
                {toolItem.summary}
                {#if attachedSubagent}
                  <span class="subagent-badge"
                    >{attachedSubagent.turnCount}
                    {attachedSubagent.turnCount === 1 ? 'turn' : 'turns'}</span
                  >
                {/if}
              </button>
              {#if expandedIds.has(toolItem.toolUseId)}
                {#if attachedSubagent}
                  <!-- TASK-N6X4R Task 3: nested subagent transcript, visually
                       marked as "someone else's work" (indent + left border +
                       muted background — see .turn-list.nested below). -->
                  <div class="subagent-nested">
                    <svelte:self
                      items={attachedSubagent.items}
                      {agentIcon}
                      {expandedIds}
                      {toggleExpanded}
                      nested={true}
                    />
                  </div>
                {:else}
                  {@const editHunks = toolDiffHunks(toolItem)}
                  {@const todos = toolItem.name === 'TodoWrite' ? toolTodos(toolItem.input) : null}
                  <div class="activity-detail">
                    {#if editHunks}
                      <div class="detail-diff">
                        <DiffHunks hunks={editHunks} />
                      </div>
                    {:else if todos}
                      <div class="todo-list">
                        {#each todos as todo, i (i)}
                          <div class="todo-row">
                            <span class="todo-marker" style="color:{todoStatusColor(todo.status)}">
                              {#if todo.status === 'completed'}
                                {@html icons.check}
                              {:else}
                                <span
                                  class="todo-dot"
                                  style="background:{todoStatusColor(todo.status)}"
                                ></span>
                              {/if}
                            </span>
                            <span class="todo-text" class:todo-done={todo.status === 'completed'}>
                              {todo.content}
                            </span>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <pre>{JSON.stringify(toolItem.input, null, 2)}</pre>
                    {/if}
                    {#if toolItem.result}
                      <pre class="result" class:error={toolItem.result.isError}>{toolItem.result
                          .content}</pre>
                    {/if}
                  </div>
                {/if}
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
</div>

<style>
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
  .thinking-node {
    background: hsl(var(--muted-foreground) / 0.5);
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
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
  }
  .assistant-text :global(code) {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85em;
  }

  /* ── tool activity row ── */
  .activity-trigger {
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
    /* TASK-N6X4R: an expanded Read/Bash result (or thinking block) has no
       size limit from the backend — bound it so one huge block can't blow
       out the pane (matches the .needs-question-text max-height treatment
       in ChatView.svelte). */
    max-height: 20rem;
    overflow-y: auto;
    overflow-x: auto;
    padding: 0.5rem 0.6rem;
    border-radius: calc(var(--radius) - 3px);
    background: hsl(var(--accent-bg));
    border: 1px solid hsl(var(--border));
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.76rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .activity-detail pre.result.error {
    color: hsl(var(--st-error));
    border-color: hsl(var(--st-error) / 0.4);
    background: hsl(var(--st-error) / 0.08);
  }

  /* ── thinking block (TASK-N6X4R) — same trigger/detail framing as a tool
     activity row, but dimmer text and no result pane, so it reads clearly as
     "thinking", never as the reply itself. ── */
  .thinking-trigger {
    font-style: italic;
    opacity: 0.85;
  }
  .thinking-text {
    font-style: italic;
    color: hsl(var(--muted-foreground));
  }

  /* ── received image (TASK-N6X4R) — display-side of the existing staging/
     send code; height-capped like everything else so a screenshot can't
     blow out the pane. ── */
  .chat-image {
    display: block;
    max-width: 100%;
    max-height: 20rem;
    width: auto;
    border-radius: calc(var(--radius) - 3px);
    border: 1px solid hsl(var(--border));
  }

  /* ── Edit/Write rendered as a diff (TASK-N6X4R) — same framing (height cap,
     border, radius) as the JSON-dump <pre> it replaces; DiffHunks supplies
     its own horizontal scroll per hunk. */
  .detail-diff {
    max-height: 20rem;
    overflow-y: auto;
    border-radius: calc(var(--radius) - 3px);
    border: 1px solid hsl(var(--border));
    background: hsl(var(--accent-bg));
  }

  /* ── TodoWrite rendered as a checklist (TASK-N6X4R) ── */
  .todo-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.3rem 0.5rem;
    border-radius: calc(var(--radius) - 3px);
    border: 1px solid hsl(var(--border));
    background: hsl(var(--accent-bg));
  }
  .todo-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.15rem 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
  }
  .todo-marker {
    flex: 0 0 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .todo-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .todo-text {
    flex: 1;
    min-width: 0;
    word-break: break-word;
  }
  .todo-done {
    color: hsl(var(--muted-foreground));
    text-decoration: line-through;
  }

  /* ── subagent nesting (TASK-N6X4R Task 3) — reads as "someone else's work",
     not primary conversation: indented, subtle left border, muted background
     wash. `.turn-list.nested` is the wrapper the recursive <svelte:self>
     mounts as, so a doubly-nested subagent (if it ever occurred) would
     visually compound rather than reset. ── */
  .subagent-trigger {
    color: hsl(var(--accent-foreground, var(--foreground)));
  }
  .subagent-badge {
    flex: 0 0 auto;
    font-size: 0.7rem;
    color: hsl(var(--muted-foreground));
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) - 4px);
    padding: 0 0.35rem;
  }
  .subagent-nested {
    margin-top: 0.2rem;
  }
  .turn-list.nested {
    padding: 0.4rem 0 0.4rem 0.7rem;
    margin-left: 0.15rem;
    border-left: 2px solid hsl(var(--border));
    background: hsl(var(--muted-foreground) / 0.04);
    border-radius: 0 calc(var(--radius) - 3px) calc(var(--radius) - 3px) 0;
  }

  @media (max-width: 700px) {
    .rail {
      flex: 0 0 1.3rem;
      min-height: 1.3rem;
    }
    .turn-row {
      gap: 0.4rem;
    }
    .user-bubble {
      max-width: 88%;
    }
  }
</style>
