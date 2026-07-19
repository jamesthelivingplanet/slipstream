/**
 * ClipboardStore — per-session "virtual clipboard" image (TASK-CWLL6).
 *
 * Persists a single decoded PNG per session under `<root>/clipboard/<id>.png`,
 * uploaded by the renderer before it sends Ctrl+V to the PTY. PATH-shimmed
 * clipboard tools on the agent side read this file to serve the image to the
 * agent process. Single-slot per session: each save overwrites the previous
 * image; the RPC layer (not this store) validates/decodes/size-limits the
 * incoming data before calling save().
 */

import fs from 'node:fs'
import path from 'node:path'
import type { IClipboardStore } from '../shared/contract.js'

const SUBDIR = 'clipboard'

class ClipboardStore implements IClipboardStore {
  private root: string

  constructor(root: string) {
    this.root = root
    fs.mkdirSync(path.join(root, SUBDIR), { recursive: true })
    try {
      fs.chmodSync(path.join(root, SUBDIR), 0o700)
    } catch {
      // best-effort: non-POSIX filesystems / Windows may not support chmod
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.root, SUBDIR, `${sessionId}.png`)
  }

  /**
   * Persist decoded PNG bytes for a session, overwriting any previous image.
   * Lets a genuine write failure throw — the RPC caller needs to know if
   * persistence failed. Only the chmod is best-effort (portability, not a
   * signal the caller needs).
   */
  save(sessionId: string, data: Buffer): void {
    const file = this.filePath(sessionId)
    fs.writeFileSync(file, data)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // best-effort: non-POSIX filesystems / Windows may not support chmod
    }
  }

  /** Remove the persisted image (session removed/GC'd). No-op if absent. */
  delete(sessionId: string): void {
    try {
      fs.unlinkSync(this.filePath(sessionId))
    } catch {
      // ignore (e.g. ENOENT — nothing was ever synced for this session)
    }
  }
}

export function createClipboardStore(root: string): IClipboardStore {
  return new ClipboardStore(root)
}
