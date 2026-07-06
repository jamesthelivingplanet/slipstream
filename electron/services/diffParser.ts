import type { DiffFileDTO, DiffHunkDTO } from '../shared/contract.js'

const DEFAULT_MAX_LINES_PER_FILE = 3000

/**
 * Unquote a git-quoted path: `"foo\tbar"` → `foo\tbar`. Git wraps a path in
 * double quotes and C-style-escapes it (octal bytes, \t, \n, \\, \") whenever
 * it contains a non-printable/non-ASCII byte or a literal quote/backslash.
 * Plain (unquoted) paths are returned as-is.
 */
function unquotePath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw
  const inner = raw.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const next = inner[i + 1]
    if (next === undefined) {
      out += c
      continue
    }
    if (next >= '0' && next <= '7') {
      // Octal byte escape: up to 3 octal digits.
      let j = i + 1
      let digits = ''
      while (j < inner.length && digits.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
        digits += inner[j]
        j++
      }
      out += String.fromCharCode(parseInt(digits, 8))
      i = j - 1
      continue
    }
    switch (next) {
      case 't':
        out += '\t'
        break
      case 'n':
        out += '\n'
        break
      case '\\':
        out += '\\'
        break
      case '"':
        out += '"'
        break
      default:
        out += next
    }
    i++
  }
  return out
}

/** Strip a leading `a/` or `b/` prefix from a `--- `/`+++ ` path. */
function stripAbPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/**
 * Best-effort path extraction from a `diff --git a/X b/Y` line. X/Y may
 * contain spaces, so the split point is ambiguous in general; when both
 * sides are quoted, or unquoted and identical (the non-rename case), the
 * exact path can be recovered. Renames/binary files fall back to whatever
 * `rename to` / the plain first token gives — good enough for a guess that
 * is overwritten by the (unambiguous) --- /+++ or rename from/to lines.
 */
function guessDiffGitPath(rest: string): string {
  if (rest.startsWith('"')) {
    const m = rest.match(/^"(?:[^"\\]|\\.)*"/)
    if (m) return m[0] // whole quoted token, e.g. `"a/foo\tbar"` — unquotePath handles it
  }
  // Equal-halves heuristic: "a/<p> b/<p>" has length 5 + 2*len(p).
  if (rest.length >= 5 && (rest.length - 5) % 2 === 0) {
    const p = (rest.length - 5) / 2
    const candidate = rest.slice(2, 2 + p)
    if (`a/${candidate} b/${candidate}` === rest) return `a/${candidate}`
  }
  const m = rest.match(/^\S+/)
  return m ? m[0] : ''
}

function newFile(path: string): DiffFileDTO {
  return {
    path,
    status: 'modified',
    binary: false,
    truncated: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  }
}

/**
 * Pure unified-diff parser (state machine over lines). Understands the subset
 * of `git diff` output produced by the invocation in worktreeManager.diff():
 * `--no-color --no-ext-diff --find-renames --unified=3`.
 */
export function parseUnifiedDiff(
  raw: string,
  opts?: { maxLinesPerFile?: number },
): { files: DiffFileDTO[]; truncated: boolean } {
  const maxLinesPerFile = opts?.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE

  const files: DiffFileDTO[] = []
  let truncated = false

  let file: DiffFileDTO | null = null
  let hunk: DiffHunkDTO | null = null
  let oldLine = 0
  let newLine = 0
  let hunkLineCount = 0
  let skipRestOfFile = false

  const lines = raw.length === 0 ? [] : raw.split('\n')

  function finishFile(): void {
    if (file) files.push(file)
    file = null
    hunk = null
    hunkLineCount = 0
    skipRestOfFile = false
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishFile()
      // "diff --git a/X b/Y" — only a fallback guess for the path (used when
      // there are no --- /+++ lines to read it from, e.g. a non-renamed
      // binary file); the --- /+++ lines below are unambiguous and preferred.
      const rest = line.slice('diff --git '.length)
      file = newFile(stripAbPrefix(unquotePath(guessDiffGitPath(rest))))
      continue
    }

    if (!file) continue // stray lines before the first "diff --git" (or after a fatal error)

    if (skipRestOfFile) {
      // still watch for the next file boundary; everything else is dropped.
      continue
    }

    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquotePath(line.slice('rename from '.length).trim())
      continue
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = unquotePath(line.slice('rename to '.length).trim())
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }
    if (line.startsWith('--- ')) {
      const side = line.slice('--- '.length).trim()
      if (side === '/dev/null') {
        file.status = 'added'
      } else {
        const p = stripAbPrefix(unquotePath(side))
        if (file.status !== 'renamed') file.path = p
        else file.oldPath = p
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      const side = line.slice('+++ '.length).trim()
      if (side === '/dev/null') {
        file.status = 'deleted'
      } else {
        file.path = stripAbPrefix(unquotePath(side))
      }
      continue
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10)
      const newStart = parseInt(hunkMatch[3], 10)
      hunk = { header: line, oldStart, newStart, lines: [] }
      file.hunks.push(hunk)
      oldLine = oldStart
      newLine = newStart
      continue
    }

    if (hunk === null) continue // metadata we don't care about (index, mode changes, etc.)

    if (line.startsWith('\\ No newline at end of file')) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }

    if (line.length === 0) {
      // A blank line in the raw diff (e.g. trailing split artifact) — treat as
      // a context line with empty content only if we're inside a hunk body.
      // (git always prefixes real content lines with ' '/'+'/'-'; an entirely
      // empty string here comes from the trailing '\n' split — skip it.)
      continue
    }

    const marker = line[0]
    if (marker !== '+' && marker !== '-' && marker !== ' ') {
      // Unrecognized row inside a hunk body — ignore rather than mis-tally.
      continue
    }

    if (hunkLineCount >= maxLinesPerFile) {
      file.truncated = true
      truncated = true
      skipRestOfFile = true
      continue
    }

    const text = line.slice(1)
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text, oldLine: null, newLine })
      file.additions++
      newLine++
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text, oldLine, newLine: null })
      file.deletions++
      oldLine++
    } else {
      hunk.lines.push({ kind: 'context', text, oldLine, newLine })
      oldLine++
      newLine++
    }
    hunkLineCount++
  }
  finishFile()

  return { files, truncated }
}
