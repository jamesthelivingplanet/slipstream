/**
 * chatBlockShared — the common core extracted from the three JSONL/row chat
 * mappers that all produce `ChatBlock[]`/`SessionChatMessageDTO`:
 * transcriptMessages.ts (claude-code), piChatMessages.ts (pi), and
 * grokChatMessages.ts (grok). (NOT antigravityChatMessages.ts — that's
 * unrelated protobuf parsing with no shared shape here.)
 *
 * Two pieces of genuinely identical control flow were shared out:
 *   - `toolResultContentToParts` — walks a tool-result `content` array,
 *     flattening text parts and pulling out sibling image blocks. Shared by
 *     transcriptMessages.ts and piChatMessages.ts only; grok's tool-result
 *     `output` field is a structurally different discriminated union (ai@6's
 *     `ToolResultOutput`), not an array of interleaved text/image parts, so
 *     grok keeps its own `toolResultOutputToString`/`toolResultContentPartsToString`.
 *   - `blocksFromContent` — the string/array guard shell around a per-item
 *     mapper, shared by all three.
 *
 * Deliberately NOT unified here (stays duplicated per-file, see each file's
 * own comments):
 *   - `imageBlockFromSource`/`imageBlockFromPart`/`imageBlockFromAiSdkValue` —
 *     three genuinely different input envelopes (nested `source.data` object
 *     vs flat `data`/`mimeType` fields vs a base64 string with optional
 *     `data:` URI unwrapping). Unifying would need per-backend branching
 *     inside one function — a de-facto flag, not a real abstraction.
 *   - `blockFromRaw`/`blockFromPart` top-level per-item switches — different
 *     type discriminants, field names, and return shapes (array vs nullable
 *     single) per backend.
 *   - `resolveTs` (pi only), `completeLines`/`createChatCursor` (transcript
 *     only, an incremental-tailing concern not a mapping concern), and
 *     grok's `toolResultOutputToString`/`safeJsonStringify`/
 *     `toolResultContentPartsToString`.
 */
import type { ChatBlock } from '../shared/contract.js'

/** A tool-result's `content` is either a plain string or an array of
 *  content-part objects (text parts interleaved with e.g. images). Text
 *  parts flatten to `.text` (joined with `\n`, empty strings filtered);
 *  `image` parts become sibling `ChatBlock`s in `.images` via the injected
 *  `imageFromPart` extractor instead of being silently dropped. */
export function toolResultContentToParts(
  content: unknown,
  imageFromPart: (part: Record<string, unknown>) => ChatBlock | null,
): { text: string; images: ChatBlock[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }

  const textParts: string[] = []
  const images: ChatBlock[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part)
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    const p = part as Record<string, unknown>
    if (p['type'] === 'image') {
      const img = imageFromPart(p)
      if (img) images.push(img)
      continue
    }
    const text = p['text']
    if (typeof text === 'string') textParts.push(text)
  }
  return { text: textParts.filter((s) => s.length > 0).join('\n'), images }
}

/** A message's `content` is either a plain string (simple prompts/commands)
 *  or an array of per-backend content-block/part objects. Each item is
 *  mapped to zero or more `ChatBlock`s via the injected `mapRaw` — callers
 *  whose own per-item mapper returns `ChatBlock | null` (pi's/grok's
 *  `blockFromRaw`/`blockFromPart`) wrap it in a trivial adapter closure
 *  rather than changing that mapper's return shape. */
export function blocksFromContent(
  content: unknown,
  mapRaw: (raw: unknown) => ChatBlock[],
): ChatBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const raw of content) blocks.push(...mapRaw(raw))
  return blocks
}
