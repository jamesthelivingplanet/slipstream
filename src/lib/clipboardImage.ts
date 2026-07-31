/** Pure "is this paste an image" decision, pulled out of TerminalView's
 *  onPaste handler so it's unit-testable without a real ClipboardEvent.
 *
 *  DataTransferItem.kind is only ever 'string' or 'file' per spec — an image
 *  on the clipboard surfaces as kind 'file' with an image/* type, never kind
 *  'image' (there is no such kind). */
export interface ClipboardItemLike {
  kind: string
  type: string
}

/** Returns the first image file item in a paste's clipboard items, or null
 *  if there isn't one (including when `items` itself is absent) — callers
 *  should let a null result fall through to xterm's own paste handling. */
export function findClipboardImageItem<T extends ClipboardItemLike>(
  items: Iterable<T> | null | undefined,
): T | null {
  if (!items) return null
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item
  }
  return null
}
