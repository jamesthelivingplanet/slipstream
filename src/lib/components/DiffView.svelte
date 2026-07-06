<script lang="ts">
  import { worktreeDiff, writeSession, hasBackend } from '../ipc'
  import {
    reviewComments,
    addReviewComment,
    removeReviewComment,
    clearReviewComments,
    confirmDialog,
  } from '../stores'
  import { composeReviewPrompt, frameForPty } from '../review.js'
  import { pushToast } from '../toast'
  import { genId } from '../id.js'
  import { icons } from '../icons'
  import type { Session } from '../types'
  import type { DiffFileDTO, DiffLineDTO, WorktreeDiffDTO } from '../../../electron/shared/contract'

  export let session: Session
  export let canWrite: boolean
  export let onSubmitted: () => void

  let loading = false
  let refreshing = false
  let hasLoadedFor: string | null = null
  let diff: WorktreeDiffDTO | null = null
  let expanded = new Set<string>()
  let submitting = false

  // Identity of the line currently showing its inline comment editor, and the
  // pending line's own data (file/side/line/lineText) needed to build the
  // comment on Add. Only one editor is open at a time.
  let editingKey: string | null = null
  let draftText = ''
  let pendingLine: { file: string; side: 'old' | 'new'; line: number; text: string } | null = null

  $: myComments = $reviewComments[session.id ?? ''] ?? []
  $: commentsByKey = (() => {
    const m = new Map<string, typeof myComments>()
    for (const c of myComments) {
      const k = keyFor(c.file, c.side, c.line)
      const arr = m.get(k)
      if (arr) arr.push(c)
      else m.set(k, [c])
    }
    return m
  })()

  $: totalAdd = diff?.files.reduce((s, f) => s + f.additions, 0) ?? 0
  $: totalDel = diff?.files.reduce((s, f) => s + f.deletions, 0) ?? 0

  $: disabledReason = !hasBackend
    ? 'No backend connection.'
    : !session.id
      ? 'Session has not started yet.'
      : !canWrite
        ? 'Another client controls this session — take over to submit.'
        : session.status !== 'running' && session.status !== 'needs' && session.status !== 'done'
          ? 'The agent is not running.'
          : ''
  $: submitDisabled = disabledReason !== '' || submitting

  function keyFor(file: string, side: 'old' | 'new', line: number): string {
    return `${file}|${side}|${line}`
  }

  /** Line identity: a 'del' line anchors on the old side, everything else
   *  (add/context) anchors on the new side. */
  function lineIdentity(line: DiffLineDTO): { side: 'old' | 'new'; line: number } | null {
    const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new'
    const n = side === 'old' ? line.oldLine : line.newLine
    return n == null ? null : { side, line: n }
  }

  function keyForLine(filePath: string, line: DiffLineDTO): string | null {
    const id = lineIdentity(line)
    return id ? keyFor(filePath, id.side, id.line) : null
  }

  function commentsFor(filePath: string, line: DiffLineDTO) {
    const key = keyForLine(filePath, line)
    return key ? (commentsByKey.get(key) ?? []) : []
  }

  async function load(isRefresh = false) {
    if (!session.repo || !session.branch) {
      diff = null
      return
    }
    if (isRefresh) refreshing = true
    else loading = true
    try {
      const result = await worktreeDiff(session.repo, session.branch)
      diff = result
      expanded = new Set(result.files.map((f) => f.path))
      editingKey = null
      pendingLine = null
    } catch (e) {
      diff = {
        branch: session.branch,
        base: '',
        mergeBase: '',
        files: [],
        truncated: false,
        error: e instanceof Error ? e.message : String(e),
      }
    } finally {
      loading = false
      refreshing = false
    }
  }

  $: if (session.id !== hasLoadedFor) {
    hasLoadedFor = session.id ?? null
    load()
  }

  function toggleExpanded(path: string) {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
  }

  function clickLine(file: DiffFileDTO, line: DiffLineDTO) {
    const id = lineIdentity(line)
    if (!id) return
    const key = keyFor(file.path, id.side, id.line)
    if (editingKey === key) {
      cancelComment()
      return
    }
    editingKey = key
    draftText = ''
    pendingLine = { file: file.path, side: id.side, line: id.line, text: line.text }
  }

  function addComment() {
    if (!pendingLine || !session.id) return
    const text = draftText.trim()
    if (!text) return
    addReviewComment(session.id, {
      id: genId(),
      file: pendingLine.file,
      side: pendingLine.side,
      line: pendingLine.line,
      lineText: pendingLine.text,
      text,
    })
    editingKey = null
    draftText = ''
    pendingLine = null
  }

  function cancelComment() {
    editingKey = null
    draftText = ''
    pendingLine = null
  }

  async function handleSubmit() {
    if (submitDisabled || !diff || !session.id) return
    submitting = true
    const n = myComments.length
    try {
      const { paste, submit } = frameForPty(composeReviewPrompt(myComments, diff.base))
      writeSession(session.id, paste)
      await new Promise((r) => setTimeout(r, 75))
      writeSession(session.id, submit)
      clearReviewComments(session.id)
      pushToast('success', `Sent ${n} review comment${n === 1 ? '' : 's'} to the agent`)
      onSubmitted()
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e))
    } finally {
      submitting = false
    }
  }

  async function handleDiscardAll() {
    if (!session.id) return
    const n = myComments.length
    const ok = await confirmDialog({
      title: 'Discard all comments?',
      message: `This discards all ${n} draft review comment${n === 1 ? '' : 's'} for this session.`,
      confirmLabel: 'Discard all',
      danger: true,
    })
    if (!ok) return
    clearReviewComments(session.id)
  }

  function statusLabel(status: DiffFileDTO['status']): string {
    switch (status) {
      case 'added':
        return 'added'
      case 'deleted':
        return 'deleted'
      case 'renamed':
        return 'renamed'
      case 'untracked':
        return 'untracked'
      default:
        return 'modified'
    }
  }

  function marker(kind: DiffLineDTO['kind']): string {
    return kind === 'add' ? '+' : kind === 'del' ? '-' : ''
  }
</script>

<div class="diffview">
  <div class="dv-scroll">
    <div class="dv-header">
      <button
        class="btn btn-outline btn-sm"
        disabled={loading || refreshing}
        title="Re-fetch the diff (does not affect your draft comments)"
        on:click={() => load(true)}
      >
        {@html icons.refresh}
        <span class="btn-label">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
      </button>
      {#if diff && !diff.error}
        <span class="dv-summary mono">
          {diff.files.length} file{diff.files.length === 1 ? '' : 's'} ·
          <span class="add">+{totalAdd}</span>
          <span class="del">−{totalDel}</span>
        </span>
        {#if diff.truncated}
          <span class="badge" title="The diff was too large and was truncated.">truncated</span>
        {/if}
      {/if}
    </div>

    {#if loading}
      <div class="dv-empty">Loading diff…</div>
    {:else if diff?.error}
      <div class="dv-error">{diff.error}</div>
    {:else if !diff || diff.files.length === 0}
      <div class="dv-empty">No changes vs {diff?.base ?? 'base'}</div>
    {:else}
      <div class="dv-files">
        {#each diff.files as file (file.path)}
          <div class="dv-file">
            <button class="dv-file-head" on:click={() => toggleExpanded(file.path)}>
              <span class="chev" class:open={expanded.has(file.path)}
                >{@html icons.chevronDown}</span
              >
              <span class="dv-path mono">
                {#if file.status === 'renamed' && file.oldPath}
                  {file.oldPath} → {file.path}
                {:else}
                  {file.path}
                {/if}
              </span>
              <span class="badge dv-status {file.status}">{statusLabel(file.status)}</span>
              {#if file.truncated}
                <span class="badge" title="This file's diff was too large and was truncated."
                  >truncated</span
                >
              {/if}
              <span class="dv-counts mono">
                <span class="add">+{file.additions}</span>
                <span class="del">−{file.deletions}</span>
              </span>
            </button>

            {#if expanded.has(file.path)}
              {#if file.binary}
                <div class="dv-note">Binary file — no preview available.</div>
              {:else if file.hunks.length === 0}
                <div class="dv-note">No line-level changes to show.</div>
              {:else}
                {#each file.hunks as hunk, hi (hi)}
                  <div class="hunk-header mono">{hunk.header}</div>
                  <div class="hunk-body">
                    {#each hunk.lines as line, li (li)}
                      <div
                        class="dline mono {line.kind}"
                        role="button"
                        tabindex="0"
                        on:click={() => clickLine(file, line)}
                        on:keydown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            clickLine(file, line)
                          }
                        }}
                      >
                        <span class="gut old">{line.oldLine ?? ''}</span>
                        <span class="gut new">{line.newLine ?? ''}</span>
                        <span class="marker">{marker(line.kind)}</span>
                        <span class="code">{line.text}</span>
                      </div>
                      {#if line.noNewline}
                        <div class="dline mono nonewline">
                          <span class="gut old"></span><span class="gut new"></span>
                          <span class="marker"></span>
                          <span class="code">\ No newline at end of file</span>
                        </div>
                      {/if}
                      {#if editingKey && editingKey === keyForLine(file.path, line)}
                        <div class="editor-row">
                          <textarea
                            bind:value={draftText}
                            placeholder="Add a comment for the agent…"
                            rows="3"
                          ></textarea>
                          <div class="editor-actions">
                            <button
                              class="btn btn-primary btn-sm"
                              disabled={!draftText.trim()}
                              on:click={addComment}>Add</button
                            >
                            <button class="btn btn-outline btn-sm" on:click={cancelComment}
                              >Cancel</button
                            >
                          </div>
                        </div>
                      {/if}
                      {#each commentsFor(file.path, line) as c (c.id)}
                        <div class="comment-card">
                          <div class="cc-text">{c.text}</div>
                          <button
                            class="btn btn-ghost btn-icon btn-sm"
                            title="Delete this comment"
                            on:click={() => removeReviewComment(session.id ?? '', c.id)}
                          >
                            {@html icons.trash}
                          </button>
                        </div>
                      {/each}
                    {/each}
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if myComments.length > 0}
    <div class="dv-footer">
      <button
        class="btn btn-primary btn-sm"
        disabled={submitDisabled}
        title={disabledReason || undefined}
        on:click={handleSubmit}
      >
        Submit {myComments.length} comment{myComments.length === 1 ? '' : 's'}
      </button>
      <button class="btn btn-outline btn-sm" on:click={handleDiscardAll}>Discard all</button>
    </div>
  {/if}
</div>

<style>
  .diffview {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .dv-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
  }
  .dv-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .dv-summary {
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    display: flex;
    gap: 6px;
  }
  .add {
    color: hsl(var(--st-done));
  }
  .del {
    color: hsl(var(--st-error));
  }
  .dv-empty,
  .dv-error {
    padding: 30px 14px;
    text-align: center;
    color: hsl(var(--muted-foreground));
    font-size: 13px;
  }
  .dv-error {
    color: hsl(var(--st-error));
  }

  .dv-files {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .dv-file {
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    overflow: hidden;
  }
  .dv-file-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    min-height: 34px;
    background: hsl(var(--card));
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
  }
  .dv-file-head:hover {
    background: hsl(var(--card-hover));
  }
  .chev {
    display: inline-flex;
    flex: 0 0 auto;
    transition: transform 0.12s;
    transform: rotate(-90deg);
    opacity: 0.7;
  }
  .chev.open {
    transform: rotate(0deg);
  }
  .dv-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dv-status.added {
    color: hsl(var(--st-done));
  }
  .dv-status.deleted {
    color: hsl(var(--st-error));
  }
  .dv-counts {
    display: flex;
    gap: 6px;
    font-size: 11px;
    flex: 0 0 auto;
  }
  .dv-note {
    padding: 10px 12px;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
  }

  .hunk-header {
    padding: 4px 10px;
    font-size: 11.5px;
    color: hsl(var(--muted-foreground));
    background: hsl(var(--accent-bg));
  }
  .hunk-body {
    overflow-x: auto;
  }
  .dline {
    display: flex;
    min-width: max-content;
    cursor: pointer;
    font-size: 12px;
    line-height: 1.6;
  }
  .dline:hover {
    filter: brightness(1.08);
  }
  .dline.add {
    background: hsl(var(--st-done) / 0.1);
  }
  .dline.del {
    background: hsl(var(--st-error) / 0.1);
  }
  .dline.nonewline {
    cursor: default;
    color: hsl(var(--muted-foreground));
    opacity: 0.65;
  }
  .gut {
    position: sticky;
    flex: 0 0 3.5ch;
    width: 3.5ch;
    text-align: right;
    padding-right: 6px;
    color: hsl(var(--muted-foreground));
    user-select: none;
    background: inherit;
  }
  .gut.old {
    left: 0;
  }
  .gut.new {
    left: 3.5ch;
  }
  .marker {
    position: sticky;
    left: 7ch;
    flex: 0 0 1.5ch;
    width: 1.5ch;
    text-align: center;
    background: inherit;
  }
  .dline.add .marker {
    color: hsl(var(--st-done));
  }
  .dline.del .marker {
    color: hsl(var(--st-error));
  }
  .code {
    flex: 1 1 auto;
    white-space: pre;
    padding: 0 10px 0 4px;
  }

  .editor-row {
    padding: 8px 10px;
    background: hsl(var(--accent-bg));
    border-top: 1px dashed hsl(var(--border));
    border-bottom: 1px dashed hsl(var(--border));
  }
  .editor-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .comment-card {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px 8px 7ch;
    background: hsl(var(--primary) / 0.06);
    border-top: 1px solid hsl(var(--border));
    border-bottom: 1px solid hsl(var(--border));
    font-size: 12.5px;
  }
  .cc-text {
    flex: 1;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .dv-footer {
    flex: 0 0 auto;
    display: flex;
    gap: 10px;
    padding: 10px 14px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    border-top: 1px solid hsl(var(--border));
    background: hsl(var(--background));
  }

  @media (max-width: 700px) {
    .dv-scroll {
      padding: 8px;
    }
    .gut {
      flex: 0 0 3ch;
      width: 3ch;
    }
    .gut.new {
      left: 3ch;
    }
    .marker {
      left: 6ch;
    }
    .dv-file-head {
      min-height: 40px;
    }
    .dline {
      min-height: 30px;
    }
  }
</style>
