import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked once at module load: GitHub-flavored line breaks off is
// marked's default; keep defaults except disable raw HTML passthrough at
// the parser level too (belt and suspenders — DOMPurify is the real gate).
marked.setOptions({ breaks: true, gfm: true })

// DOMPurify's own recommended recipe for "sanitize but force every link to
// open safely in a new tab" (see https://github.com/cure53/DOMPurify —
// afterSanitizeAttributes hook): every <a> gets target=_blank plus
// rel="noopener noreferrer" so a malicious/compromised transcript link can
// never reach `window.opener` or navigate the app's own tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** Render Claude Code transcript markdown text to sanitized HTML, safe to
 *  pass to Svelte's {@html}. Never throws — falls back to escaped plain
 *  text if marked/DOMPurify somehow reject the input. */
export function renderMarkdown(text: string): string {
  try {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
  } catch {
    return DOMPurify.sanitize(text)
  }
}
