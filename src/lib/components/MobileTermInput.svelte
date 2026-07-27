<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ptySequenceForEdit, codePointIndex, type PtyEditState } from '../ptyInput'
  import { icons } from '../icons'
  import {
    dictationAvailable,
    startDictation,
    appendTranscript,
    type DictationSession,
  } from '../speech'
  import { pushToast } from '../toast'

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

  // FLO-155: computed once at component init — neither backend's
  // availability changes over the component's lifetime, so there's no need
  // to re-check on every render.
  const canDictate = dictationAvailable()
  let dictating = false
  let dictSession: DictationSession | null = null
  // Text already in the input when dictation started — the base onTranscript
  // appends onto, so refinements replace only what THIS dictation produced.
  let dictBase = ''

  function handleInput() {
    const next: PtyEditState = {
      text: el.value,
      cursor: codePointIndex(el.value, el.selectionStart ?? el.value.length),
    }
    const seq = ptySequenceForEdit(prev, next)
    if (seq) onData(seq)
    prev = next
  }

  /** Safe to call whether or not dictation is active — a no-op when idle.
   *  stop() triggers onEnd asynchronously (native listeningState event /
   *  Web Speech API onend), so this is deliberately fire-and-forget; onEnd's
   *  own `ended` guard makes a repeat call harmless. */
  function stopDictation() {
    if (dictating) dictSession?.stop()
  }

  /** onTranscript: replace-everything transcript for the CURRENT dictation,
   *  appended onto whatever was in the input when dictation started. Routed
   *  through the same handleInput() diff path as typing — ptySequenceForEdit
   *  computes the minimal backspace/retype, so live dictation refinements
   *  (the engine revising its guess mid-utterance) stay cheap on the wire. */
  function onTranscript(text: string) {
    const next = appendTranscript(dictBase, text)
    if (next === el.value) return
    el.value = next
    el.setSelectionRange(next.length, next.length)
    handleInput()
  }

  function onEnd(error?: string) {
    dictating = false
    dictSession = null
    // onend fires asynchronously (Web Speech API), so it can land after the
    // component was destroyed and Svelte has nulled `el` — guard every
    // el-touching bit rather than let a stray TypeError escape.
    if (el) {
      // Base for a second tap: append after what was just dictated rather
      // than overwriting it.
      dictBase = el.value
      el.focus()
    }
    if (error) pushToast('error', error)
  }

  function toggleDictation() {
    if (dictating) {
      if (dictSession) {
        // Don't flip `dictating` here — onEnd (fired once stop() completes)
        // is the single place that resets dictation state.
        dictSession.stop()
      } else {
        // Still in flight: startDictation hasn't resolved yet, so there's no
        // session to stop. Flip `dictating` off now so the race guard in the
        // .then() below stops the session as soon as it arrives, instead of
        // silently adopting it and leaving the mic stuck on "listening".
        dictating = false
      }
      return
    }
    dictBase = el.value
    dictating = true
    startDictation({ onTranscript, onEnd })
      .then((session) => {
        // Race guard: the user may have toggled off again (fast second tap,
        // or the component was destroyed) while startDictation was still
        // resolving. If so, stop the session that just arrived instead of
        // adopting it.
        if (!dictating) {
          session.stop()
          return
        }
        dictSession = session
      })
      .catch((err) => {
        dictating = false
        dictSession = null
        pushToast('error', err instanceof Error ? err.message : String(err))
      })
  }

  onDestroy(() => {
    stopDictation()
  })

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
    stopDictation()
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
  {#if canDictate}
    <button
      type="button"
      class="btn btn-outline term-mic"
      class:listening={dictating}
      {disabled}
      aria-pressed={dictating}
      aria-label={dictating ? 'Stop dictation' : 'Dictate a reply'}
      title={dictating ? 'Stop dictation' : 'Dictate a reply'}
      on:mousedown|preventDefault={() => {}}
      on:click={toggleDictation}
    >
      {@html icons.mic}
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
  /* Mic toggle: sits in the .term-input row, right before the text input —
     same fixed-size icon-button treatment as .term-attach, but with its own
     "listening" pulse so it's obvious dictation is live even at a glance. */
  .term-mic {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    padding: 0;
    min-height: 40px;
    justify-content: center;
  }
  .term-mic.listening {
    border-color: hsl(var(--destructive));
    color: hsl(var(--destructive));
    animation: term-mic-pulse 1.4s ease-in-out infinite;
  }
  @keyframes term-mic-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .term-mic.listening {
      animation: none;
    }
  }
  /* .term-input's own border-top already separates the composer from
     whatever is above it; .term-actions (app.css) normally adds its own
     border-top too, but that would double up right where the chip row now
     sits flush against it, so drop it here exactly like the input row does. */
  .term-chips + :global(.term-actions) {
    border-top: none;
  }
</style>
