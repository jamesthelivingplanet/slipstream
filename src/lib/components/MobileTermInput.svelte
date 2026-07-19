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
