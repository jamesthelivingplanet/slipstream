<script lang="ts">
  import { ptySequenceForEdit, codePointIndex, type PtyEditState } from '../ptyInput'

  /** Disable typing while another client holds the write lock. */
  export let disabled = false
  /** Sink for PTY-bound bytes (wired to writeSession by the parent). */
  export let onData: (data: string) => void

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
  />
</div>
