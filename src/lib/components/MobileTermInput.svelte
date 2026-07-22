<script lang="ts">
  import { ptySequenceForEdit, codePointIndex, type PtyEditState } from '../ptyInput'

  /** Disable typing while another client holds the write lock. */
  export let disabled = false
  /** Sink for PTY-bound bytes (wired to writeSession by the parent). */
  export let onData: (data: string) => void
  /** Multi-line/large paste sink — bypasses the diff-based composer entirely. */
  export let onPaste: (text: string) => void
  /** Image clipboard paste sink (wired by the parent to upload+^V). Undefined = feature not wired, skip silently. */
  export let onPasteImage: ((blob: Blob) => void) | undefined = undefined

  let el: HTMLInputElement
  // Where we last left the PTY line/cursor — the diff base for the next edit.
  let prev: PtyEditState = { text: '', cursor: 0 }

  function handleInput() {
    const next: PtyEditState = {
      text: el.value,
      cursor: codePointIndex(el.value, el.selectionStart ?? el.value.length),
    }
    const seq = ptySequenceForEdit(prev, next)
    if (seq) onData(seq)
    prev = next
  }

  function send() {
    onData('\r')
    el.value = ''
    prev = { text: '', cursor: 0 }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    send()
  }

  // Some Android IMEs signal the action key via beforeinput, not keydown.
  function handleBeforeInput(e: InputEvent) {
    if (e.inputType !== 'insertLineBreak') return
    e.preventDefault()
    send()
  }

  /** Quick-key chips: send a raw control/ANSI sequence without stealing focus
   *  from the composer input, so the user can keep typing right after. */
  function sendChip(seq: string) {
    onData(seq)
    el?.focus()
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (items) {
      for (const item of items) {
        if (item.kind === 'image') {
          if (onPasteImage) {
            e.preventDefault()
            const blob = item.getAsFile()
            if (blob) onPasteImage(blob)
            return
          }
          break
        }
      }
    }
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (text.includes('\n') || text.length > 2000) {
      e.preventDefault()
      onPaste(text)
    }
    // else: let default input-diff behavior proceed — local echo in the
    // composer is better UX for short single-line snippets, and handleInput's
    // existing diff (`prev` state) already accounts for whatever the browser
    // inserts natively, so no further bookkeeping is needed here.
  }
</script>

<div class="term-input">
  <input
    bind:this={el}
    type="text"
    {disabled}
    placeholder="Type to the agent — Enter sends"
    autocapitalize="off"
    autocomplete="off"
    autocorrect="off"
    spellcheck="false"
    enterkeyhint="send"
    on:input={handleInput}
    on:keydown={handleKeydown}
    on:beforeinput={handleBeforeInput}
    on:paste={handlePaste}
  />
</div>

<div class="term-chips" role="group" aria-label="Quick keys">
  <button
    type="button"
    class="btn btn-outline btn-sm chip"
    tabindex="-1"
    {disabled}
    title="Escape"
    on:mousedown|preventDefault={() => {}}
    on:click={() => sendChip('\x1b')}
  >
    Esc
  </button>
  <button
    type="button"
    class="btn btn-outline btn-sm chip"
    tabindex="-1"
    {disabled}
    title="Tab"
    on:mousedown|preventDefault={() => {}}
    on:click={() => sendChip('\t')}
  >
    Tab
  </button>
  <button
    type="button"
    class="btn btn-outline btn-sm chip"
    tabindex="-1"
    {disabled}
    title="Interrupt (Ctrl+C)"
    on:mousedown|preventDefault={() => {}}
    on:click={() => sendChip('\x03')}
  >
    Ctrl+C
  </button>
  <button
    type="button"
    class="btn btn-outline btn-sm chip"
    tabindex="-1"
    {disabled}
    title="Previous (history up)"
    on:mousedown|preventDefault={() => {}}
    on:click={() => sendChip('\x1b[A')}
  >
    &uarr;
  </button>
  <button
    type="button"
    class="btn btn-outline btn-sm chip"
    tabindex="-1"
    {disabled}
    title="Next (history down)"
    on:mousedown|preventDefault={() => {}}
    on:click={() => sendChip('\x1b[B')}
  >
    &darr;
  </button>
</div>

<style>
  /* Quick-key row: sits directly under the composer input, sharing its
     background so the two read as one composer surface. Chips are plain
     .btn/.btn-outline/.btn-sm (see app.css) so they match every other
     toolbar control in the app — only the row layout is new here. */
  .term-chips {
    display: flex;
    gap: 6px;
    padding: 4px 8px 8px;
    background: hsl(var(--background));
    overflow-x: auto;
  }
  .chip {
    flex: 0 0 auto;
    font-family: 'JetBrains Mono', monospace;
  }
  /* .term-input's own border-top already separates the composer from
     whatever is above it; .term-actions (app.css) normally adds its own
     border-top too, but that would double up right where the chip row now
     sits flush against it, so drop it here exactly like the input row does. */
  .term-chips + :global(.term-actions) {
    border-top: none;
  }
</style>
