<script lang="ts">
  import { ptySequenceForEdit, codePointIndex, type PtyEditState } from '../ptyInput'
  import { icons } from '../icons'

  /** Disable typing while another client holds the write lock. */
  export let disabled = false
  /** Sink for PTY-bound bytes (wired to writeSession by the parent). */
  export let onData: (data: string) => void
  /** Multi-line/large paste sink — bypasses the diff-based composer entirely. */
  export let onPaste: (text: string) => void
  /** Image attach sink (wired by the parent to upload+^V, run just before the Enter that sends).
   *  Undefined = feature not wired, hide the attach button. Used for both the file-attach button
   *  and clipboard-paste (both stage locally first, so neither can race the Enter that follows). */
  export let onAttachImage: ((blob: Blob) => Promise<void>) | undefined = undefined

  let el: HTMLInputElement
  let fileInput: HTMLInputElement
  // Where we last left the PTY line/cursor — the diff base for the next edit.
  let prev: PtyEditState = { text: '', cursor: 0 }
  // Picked-but-not-yet-sent image, previewed above the input row.
  let stagedImage: { blob: Blob; previewUrl: string } | null = null

  function handleInput() {
    const next: PtyEditState = {
      text: el.value,
      cursor: codePointIndex(el.value, el.selectionStart ?? el.value.length),
    }
    const seq = ptySequenceForEdit(prev, next)
    if (seq) onData(seq)
    prev = next
  }

  async function send() {
    if (stagedImage) {
      const blob = stagedImage.blob
      URL.revokeObjectURL(stagedImage.previewUrl)
      stagedImage = null
      try {
        await onAttachImage?.(blob)
      } catch (err) {
        console.warn('Failed to attach image', err)
      }
    }
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
</script>

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

<div class="term-input">
  {#if onAttachImage}
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
      {disabled}
      on:click={() => fileInput.click()}
    >
      {@html icons.image}
    </button>
  {/if}
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
