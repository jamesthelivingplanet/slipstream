/**
 * OSC 52 clipboard support.
 *
 * OSC 52 is a terminal escape sequence a remote program (tmux, vim `"+y`,
 * etc.) emits to write to the *local* clipboard — the one attached to the
 * terminal emulator, not the remote host. xterm.js hands us the OSC payload
 * (terminator already stripped) via `term.parser.registerOscHandler(52, cb)`.
 *
 * Payload format: `<targets>;<base64>` — targets is usually `c` (clipboard)
 * or empty; a bare `?` in place of the base64 part is a clipboard-READ query
 * (the remote asking to read back the clipboard contents), which we must
 * never answer — see the caller in TerminalView.svelte for the rationale.
 */

const MAX_DECODED_BYTES = 1048576 // 1 MiB

/**
 * Decode an OSC 52 payload into the UTF-8 text it encodes, or `null` if the
 * payload is malformed, a read-query (`?`), or decodes to more than 1 MiB.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep === -1) return null

  const b64 = data.slice(sep + 1)
  if (b64 === '?') return null

  let binary: string
  try {
    binary = atob(b64)
  } catch {
    return null
  }

  if (binary.length > MAX_DECODED_BYTES) return null

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Write text to the local clipboard. Tries the async Clipboard API first
 * (may be unavailable, e.g. plain-http web mode), falling back to a hidden
 * textarea + `document.execCommand('copy')`. Never throws — resolves
 * `false` on total failure. Relies on the transient user-activation window
 * that typically still covers the OSC 52 sequence's arrival.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // fall through to the execCommand fallback
      }
    }

    if (typeof document === 'undefined') return false

    const previousActive = document.activeElement
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    textarea.remove()
    // Restore focus (e.g. to xterm.js) so the copy doesn't silently defocus the terminal.
    if (previousActive instanceof HTMLElement && document.contains(previousActive)) {
      previousActive.focus()
    }
    return ok
  } catch {
    return false
  }
}
