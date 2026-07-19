/**
 * Osc52Stripper — removes OSC 52 clipboard-write escape sequences from a
 * stream of PTY output before it is persisted to scrollback.
 *
 * Why: persisted scrollback is replayed as live `data` on session resume
 * (see sessionManager.ts), which would re-trigger the renderer's OSC 52
 * clipboard handler with stale/replayed data. Large base64 clipboard
 * payloads also waste the scrollback size budget and can be corrupted by
 * ScrollbackStore's tail-slice truncation if cut mid-sequence. Stripping
 * them at persistence time avoids both problems; live emission elsewhere
 * in the app is untouched.
 *
 * Implemented as a small character-scanning state machine (not a
 * whole-chunk regex) so a sequence split arbitrarily across multiple
 * `push()` calls — including inside the introducer or the base64 payload
 * — is still matched correctly.
 */

const INTRO = '\x1b]52;'
const MAX_CANDIDATE = 512 * 1024 // 512 KiB bound on held-but-unresolved bytes

type State = 'normal' | 'matching' | 'confirmed'

export class Osc52Stripper {
  private state: State = 'normal'
  private candidate = ''
  private matchLen = 0
  // In 'confirmed' state: true if the previous byte was an ESC that might
  // start the ST terminator (\x1b\\) — resolved by the next byte, which may
  // arrive in a later push() call.
  private pendingEsc = false

  /**
   * Feed the next chunk of PTY output through the filter. Returns the
   * chunk's contribution to the stripped output stream; internal state
   * persists across calls so sequences split across chunks are still
   * detected and removed.
   */
  push(chunk: string): string {
    let out = ''
    let i = 0

    while (i < chunk.length) {
      if (this.state === 'normal') {
        const escIdx = chunk.indexOf('\x1b', i)
        if (escIdx === -1) {
          out += chunk.slice(i)
          i = chunk.length
          break
        }
        out += chunk.slice(i, escIdx)
        i = escIdx
        this.state = 'matching'
        this.candidate = ''
        this.matchLen = 0
        // fall through to process this ESC in the 'matching' branch below
        continue
      }

      if (this.state === 'matching') {
        const ch = chunk[i]
        i += 1
        this.candidate += ch
        if (ch === INTRO[this.matchLen]) {
          this.matchLen += 1
          if (this.matchLen === INTRO.length) {
            // Confirmed as OSC 52 — keep the matched introducer bytes in
            // `candidate` (don't reset it) so that if this sequence never
            // terminates and overflows the cap, the whole thing (introducer
            // included) flushes through unmodified rather than losing the
            // introducer bytes.
            this.state = 'confirmed'
          }
        } else {
          // Not the OSC 52 introducer — flush what we held and resume
          // normal scanning (the mismatching char is included in the flush).
          out += this.candidate
          this.candidate = ''
          this.matchLen = 0
          this.state = 'normal'
          continue
        }

        if (this.state === 'matching' && this.candidate.length > MAX_CANDIDATE) {
          out += this.candidate
          this.candidate = ''
          this.matchLen = 0
          this.state = 'normal'
        }
        continue
      }

      // this.state === 'confirmed': scanning for the terminator, discarding
      // the payload (this is the actual stripping — never emitted).
      const ch = chunk[i]
      i += 1

      if (this.pendingEsc) {
        // Previous byte was an ESC that might have started the ST
        // terminator (\x1b\\); this byte resolves it, even if it arrived
        // in a later push() call than the ESC did.
        this.pendingEsc = false
        if (ch === '\\') {
          this.candidate = ''
          this.state = 'normal'
          continue
        }
        // False alarm — the ESC was just part of the payload; restore it
        // to the candidate and fall through to process `ch` normally.
        this.candidate += '\x1b'
      }

      if (ch === '\x07') {
        // BEL terminator — sequence complete, discard candidate.
        this.candidate = ''
        this.state = 'normal'
        continue
      }

      if (ch === '\x1b') {
        // Possible start of ST terminator; deferred until the next byte,
        // which may not have arrived yet in this chunk.
        this.pendingEsc = true
      } else {
        this.candidate += ch
      }

      if (this.candidate.length > MAX_CANDIDATE) {
        // Malformed/unterminated — let it through raw so the stream never
        // wedges or grows the buffer unboundedly.
        out += this.candidate
        this.candidate = ''
        this.state = 'normal'
        this.pendingEsc = false
      }
    }

    return out
  }
}
