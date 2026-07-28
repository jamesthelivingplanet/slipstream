<script lang="ts">
  // Presentational hunk rendering shared by DiffView (real worktree diffs,
  // click-to-comment) and ChatView (Edit/Write tool_use rendered as a diff,
  // read-only) — extracted (TASK-N6X4R) so the .hunk-header/.hunk-body/.dline/
  // .gut/.marker/.code styling lives in exactly one place. This component only
  // draws hunks; it knows nothing about review comments or PTY submission.
  import type { DiffHunkDTO, DiffLineDTO } from '../../../electron/shared/contract'

  export let hunks: DiffHunkDTO[]
  // When provided, each real line (not the synthetic "no newline" row) is
  // clickable/keyboard-activatable and calls back with that line — DiffView
  // uses this to open its inline comment editor. Left unset (the ChatView
  // case), lines render as plain read-only rows.
  export let onLineClick: ((line: DiffLineDTO) => void) | null = null

  function marker(kind: DiffLineDTO['kind']): string {
    return kind === 'add' ? '+' : kind === 'del' ? '-' : ''
  }
</script>

{#each hunks as hunk, hi (hi)}
  <div class="hunk-header mono">{hunk.header}</div>
  <div class="hunk-body">
    {#each hunk.lines as line, li (li)}
      {#if onLineClick}
        <!-- Interactive (DiffView): static role/tabindex, not conditional
             expressions — svelte-check's a11y check can't correlate a dynamic
             tabindex with a dynamic role, so this stays two branches rather
             than one div with conditional attributes. -->
        <div
          class="dline mono clickable {line.kind}"
          role="button"
          tabindex="0"
          on:click={() => onLineClick?.(line)}
          on:keydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onLineClick?.(line)
            }
          }}
        >
          <span class="gut old">{line.oldLine ?? ''}</span>
          <span class="gut new">{line.newLine ?? ''}</span>
          <span class="marker">{marker(line.kind)}</span>
          <span class="code">{line.text}</span>
        </div>
      {:else}
        <!-- Read-only (ChatView): plain presentational row, no button semantics. -->
        <div class="dline mono {line.kind}">
          <span class="gut old">{line.oldLine ?? ''}</span>
          <span class="gut new">{line.newLine ?? ''}</span>
          <span class="marker">{marker(line.kind)}</span>
          <span class="code">{line.text}</span>
        </div>
      {/if}
      {#if line.noNewline}
        <div class="dline mono nonewline">
          <span class="gut old"></span><span class="gut new"></span>
          <span class="marker"></span>
          <span class="code">\ No newline at end of file</span>
        </div>
      {/if}
      <!-- Caller-supplied content anchored to this line (DiffView's inline
           comment editor + comment cards) — nothing renders here by default. -->
      <slot name="afterLine" {line} />
    {/each}
  </div>
{/each}

<style>
  .hunk-header {
    padding: 4px 10px;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    background: hsl(var(--accent-bg));
  }
  .hunk-body {
    overflow-x: auto;
  }
  .dline {
    display: flex;
    min-width: max-content;
    cursor: default;
    font-size: 12px;
    line-height: 1.6;
  }
  .dline.clickable {
    cursor: pointer;
  }
  .dline.clickable:hover {
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

  @media (max-width: 700px) {
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
    .dline {
      min-height: 30px;
    }
  }
</style>
