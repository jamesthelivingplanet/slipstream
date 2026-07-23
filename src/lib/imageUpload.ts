/** Pure clipboard-image upload sequencing, shared by TerminalView, ChatView,
 *  and MobileTermInput's parent wiring. No `ipc`/`stores` imports — callers
 *  build an `ImageUploadDeps` from their own imports (dependency injection),
 *  which keeps this module unit-testable under vitest's `node` environment
 *  (no DOM, no `window.slipstream`). See src/lib/review.ts for the same
 *  convention. */

export interface ImageUploadDeps {
  syncClipboardImage: (id: string, dataBase64: string) => Promise<void>
  writeSession: (id: string, data: string) => void
  markSessionInput: (id: string) => void
}

const CHUNK_SIZE = 0x8000

/** Pure, chunked to avoid stack blowups on huge arrays (`String.fromCharCode
 *  .apply` on a multi-MB array would blow the call stack in one shot). Builds
 *  the full binary string via fixed-size chunks, then base64-encodes it in a
 *  single `btoa` call — chunking per-`btoa` call would need padding handled
 *  mid-string on non-3-byte-aligned chunk boundaries, so we don't. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE)
    binary += String.fromCharCode.apply(null, chunk as unknown as number[])
  }
  return btoa(binary)
}

/** Blob.arrayBuffer() -> bytesToBase64. Works in node vitest (no FileReader
 *  required — FileReader is not a Node global, and this repo's test env has
 *  no jsdom/happy-dom). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  return bytesToBase64(new Uint8Array(buf))
}

/** Sequencing orchestrator — order matters and is the tested contract:
 *    1. b64 = await blobToBase64(blob)
 *    2. await deps.syncClipboardImage(sessionId, b64)   // IPC round-trip completes
 *    3. deps.markSessionInput(sessionId)
 *    4. deps.writeSession(sessionId, '\x16')            // Ctrl+V AFTER upload resolved
 *  The upload must fully resolve before the Ctrl+V signal is written, so
 *  whatever the caller flushes next (keystrokes, Enter) can be sequenced
 *  behind this promise. This is the awaitable variant — every caller must
 *  await it (or gate subsequent writes on it); there is no fire-and-forget
 *  wrapper. */
export async function uploadClipboardImage(
  deps: ImageUploadDeps,
  sessionId: string,
  blob: Blob,
): Promise<void> {
  const b64 = await blobToBase64(blob)
  await deps.syncClipboardImage(sessionId, b64)
  deps.markSessionInput(sessionId)
  deps.writeSession(sessionId, '\x16')
}
