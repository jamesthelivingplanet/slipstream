<script lang="ts">
  import { ptySequenceForEdit, codePointIndex, type PtyEditState } from '../ptyInput'
  import { icons } from '../icons'

  /** Disable typing while another client holds the write lock. */
  export let disabled = false
  /** Sink for PTY-bound bytes (wired to writeSession by the parent). */
  export let onData: (data: string) => void
  /** Multi-line/large paste sink — bypasses the diff-based composer entirely. */
  export let onPaste: (text: string) => void
  /** Image clipboard paste sink (wired by the parent to upload+^V). Undefined = feature not wired, skip silently. */
  export let onPasteImage: ((blob: Blob) => void) | undefined = undefined
  /** Image attach sink (wired by the parent to upload+^V, run just before the Enter that sends). Undefined = feature not wired, hide the attach button. */
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
      <img src={stagedImage.previewUrl} alt="Attached image preview" />
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
