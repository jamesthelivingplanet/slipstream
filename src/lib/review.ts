/** Pure logic for composing a review prompt from accumulated diff comments and
 *  framing it for a PTY paste. No backend/store dependencies — unit-tested in
 *  isolation. See src/lib/components/DiffView.svelte for the UI that drives this. */

export interface ReviewComment {
  id: string // via src/lib/id.ts
  file: string
  side: 'old' | 'new'
  line: number
  lineText: string // quoted diff line, anchors the comment for the LLM
  text: string
}

/** Compose a single multi-line prompt from accumulated review comments, grouped
 *  by file (in the order each file's first comment was added), then by line
 *  within a file. `base` is the branch the diff was computed against, echoed
 *  in the header so the agent knows what the line numbers refer to. */
export function composeReviewPrompt(comments: ReviewComment[], base: string): string {
  const fileOrder: string[] = []
  for (const c of comments) {
    if (!fileOrder.includes(c.file)) fileOrder.push(c.file)
  }
  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? []
    arr.push(c)
    byFile.set(c.file, arr)
  }

  const lines: string[] = [
    `Please address the following review comments on your current changes (line numbers refer to the diff vs ${base}):`,
  ]

  let n = 0
  for (const file of fileOrder) {
    const fileComments = [...(byFile.get(file) ?? [])].sort((a, b) => a.line - b.line)
    for (const c of fileComments) {
      n++
      const suffix = c.side === 'old' ? ' (removed line)' : ''
      lines.push('')
      lines.push(`${n}. ${c.file}:${c.line}${suffix}`)
      lines.push(`   > ${c.lineText}`)
      for (const textLine of c.text.split('\n')) {
        lines.push(`   ${textLine}`)
      }
    }
  }

  return lines.join('\n')
}

/** Wrap a prompt for a PTY: bracketed paste so multi-line text lands as one
 *  paste (not per-line submits), then a bare carriage return to submit. */
export function frameForPty(prompt: string): { paste: string; submit: string } {
  return { paste: '\x1b[200~' + prompt + '\x1b[201~', submit: '\r' }
}
