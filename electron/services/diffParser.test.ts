import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from './diffParser.js'

describe('parseUnifiedDiff', () => {
  it('returns no files for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({ files: [], truncated: false })
  })

  it('parses a simple modified file with correct line numbers', () => {
    const raw = `diff --git a/foo.txt b/foo.txt
index abc123..def456 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,4 @@
 line one
-line two
+line two changed
+line new
 line three
`
    const { files, truncated } = parseUnifiedDiff(raw)
    expect(truncated).toBe(false)
    expect(files).toHaveLength(1)
    const f = files[0]
    expect(f.path).toBe('foo.txt')
    expect(f.status).toBe('modified')
    expect(f.binary).toBe(false)
    expect(f.additions).toBe(2)
    expect(f.deletions).toBe(1)
    expect(f.hunks).toHaveLength(1)
    const hunk = f.hunks[0]
    expect(hunk.oldStart).toBe(1)
    expect(hunk.newStart).toBe(1)
    expect(hunk.lines).toEqual([
      { kind: 'context', text: 'line one', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'line two', oldLine: 2, newLine: null },
      { kind: 'add', text: 'line two changed', oldLine: null, newLine: 2 },
      { kind: 'add', text: 'line new', oldLine: null, newLine: 3 },
      { kind: 'context', text: 'line three', oldLine: 3, newLine: 4 },
    ])
  })

  it('tracks exact line numbers across multiple hunks', () => {
    const raw = `diff --git a/multi.txt b/multi.txt
index abc..def 100644
--- a/multi.txt
+++ b/multi.txt
@@ -2,2 +2,3 @@
 keep
+added at 3
 keep2
@@ -10,3 +11,2 @@
 ctx10
-removed
 ctx12
`
    const { files } = parseUnifiedDiff(raw)
    expect(files).toHaveLength(1)
    const [h1, h2] = files[0].hunks
    expect(h1.oldStart).toBe(2)
    expect(h1.newStart).toBe(2)
    expect(h1.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 2, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ])
    expect(h2.oldStart).toBe(10)
    expect(h2.newStart).toBe(11)
    expect(h2.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 10, 11],
      ['del', 11, null],
      ['context', 12, 12],
    ])
  })

  it('treats a hunk with single-line old/new counts (b/d omitted means 1)', () => {
    const raw = `diff --git a/one.txt b/one.txt
index abc..def 100644
--- a/one.txt
+++ b/one.txt
@@ -5 +5,2 @@
-solo
+solo changed
+extra
`
    const { files } = parseUnifiedDiff(raw)
    const hunk = files[0].hunks[0]
    expect(hunk.oldStart).toBe(5)
    expect(hunk.newStart).toBe(5)
    expect(hunk.lines[0]).toEqual({ kind: 'del', text: 'solo', oldLine: 5, newLine: null })
  })

  it('marks an added (new) file, with /dev/null on the old side', () => {
    const raw = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`
    const { files } = parseUnifiedDiff(raw)
    expect(files[0].status).toBe('added')
    expect(files[0].path).toBe('new.txt')
    expect(files[0].additions).toBe(2)
    expect(files[0].deletions).toBe(0)
  })

  it('marks a deleted file, with /dev/null on the new side', () => {
    const raw = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abc123..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-now
`
    const { files } = parseUnifiedDiff(raw)
    expect(files[0].status).toBe('deleted')
    expect(files[0].path).toBe('gone.txt')
    expect(files[0].deletions).toBe(2)
  })

  it('handles a rename with content edits, capturing oldPath', () => {
    const raw = `diff --git a/old-name.txt b/new-name.txt
similarity index 90%
rename from old-name.txt
rename to new-name.txt
index abc..def 100644
--- a/old-name.txt
+++ b/new-name.txt
@@ -1,2 +1,2 @@
-hello
+hello there
 unchanged
`
    const { files } = parseUnifiedDiff(raw)
    expect(files).toHaveLength(1)
    expect(files[0].status).toBe('renamed')
    expect(files[0].oldPath).toBe('old-name.txt')
    expect(files[0].path).toBe('new-name.txt')
    expect(files[0].hunks).toHaveLength(1)
  })

  it('handles a hunkless 100%-similarity rename', () => {
    const raw = `diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
`
    const { files } = parseUnifiedDiff(raw)
    expect(files).toHaveLength(1)
    expect(files[0].status).toBe('renamed')
    expect(files[0].oldPath).toBe('old.txt')
    expect(files[0].path).toBe('renamed.txt')
    expect(files[0].hunks).toEqual([])
  })

  it('marks a binary file, with no hunks', () => {
    const raw = `diff --git a/image.png b/image.png
index abc123..def456 100644
Binary files a/image.png and b/image.png differ
`
    const { files } = parseUnifiedDiff(raw)
    expect(files[0].binary).toBe(true)
    expect(files[0].path).toBe('image.png')
    expect(files[0].hunks).toEqual([])
  })

  it('marks a binary file with a GIT binary patch body', () => {
    const raw = `diff --git a/blob.bin b/blob.bin
index abc123..def456 100644
GIT binary patch
literal 10
Hc$@<O>fS>K000000
`
    const { files } = parseUnifiedDiff(raw)
    expect(files[0].binary).toBe(true)
    expect(files[0].hunks).toEqual([])
  })

  it('sets noNewline on the preceding line', () => {
    const raw = `diff --git a/eof.txt b/eof.txt
index abc..def 100644
--- a/eof.txt
+++ b/eof.txt
@@ -1 +1 @@
-old content
\\ No newline at end of file
+new content
\\ No newline at end of file
`
    const { files } = parseUnifiedDiff(raw)
    const lines = files[0].hunks[0].lines
    expect(lines[0]).toMatchObject({ kind: 'del', text: 'old content', noNewline: true })
    expect(lines[1]).toMatchObject({ kind: 'add', text: 'new content', noNewline: true })
  })

  it('handles quoted paths with escape sequences', () => {
    const raw = `diff --git "a/tab\\tfile.txt" "b/tab\\tfile.txt"
index abc..def 100644
--- "a/tab\\tfile.txt"
+++ "b/tab\\tfile.txt"
@@ -1 +1 @@
-old
+new
`
    const { files } = parseUnifiedDiff(raw)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('tab\tfile.txt')
  })

  it('handles unquoted paths containing spaces', () => {
    const raw = `diff --git a/my file.txt b/my file.txt
index abc..def 100644
--- a/my file.txt
+++ b/my file.txt
@@ -1 +1 @@
-old
+new
`
    const { files } = parseUnifiedDiff(raw)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('my file.txt')
  })

  it('applies the per-file hunk-line cap and marks the file (and result) truncated', () => {
    const hunkLines = Array.from({ length: 10 }, (_, i) => `+added line ${i}`).join('\n')
    const raw = `diff --git a/big.txt b/big.txt
index abc..def 100644
--- a/big.txt
+++ b/big.txt
@@ -1,0 +1,10 @@
${hunkLines}
`
    const { files, truncated } = parseUnifiedDiff(raw, { maxLinesPerFile: 5 })
    expect(truncated).toBe(true)
    expect(files[0].truncated).toBe(true)
    expect(files[0].hunks[0].lines).toHaveLength(5)
  })

  it('resumes correctly for files after a truncated file', () => {
    const bigHunk = Array.from({ length: 10 }, (_, i) => `+added line ${i}`).join('\n')
    const raw = `diff --git a/big.txt b/big.txt
index abc..def 100644
--- a/big.txt
+++ b/big.txt
@@ -1,0 +1,10 @@
${bigHunk}
diff --git a/small.txt b/small.txt
index abc..def 100644
--- a/small.txt
+++ b/small.txt
@@ -1 +1 @@
-old
+new
`
    const { files, truncated } = parseUnifiedDiff(raw, { maxLinesPerFile: 5 })
    expect(files).toHaveLength(2)
    expect(files[0].truncated).toBe(true)
    expect(files[1].path).toBe('small.txt')
    expect(files[1].truncated).toBe(false)
    expect(files[1].additions).toBe(1)
    expect(truncated).toBe(true)
  })

  it('parses multiple independent files in one raw diff', () => {
    const raw = `diff --git a/one.txt b/one.txt
index abc..def 100644
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+b
diff --git a/two.txt b/two.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/two.txt
@@ -0,0 +1 @@
+hello
`
    const { files } = parseUnifiedDiff(raw)
    expect(files).toHaveLength(2)
    expect(files[0].path).toBe('one.txt')
    expect(files[0].status).toBe('modified')
    expect(files[1].path).toBe('two.txt')
    expect(files[1].status).toBe('added')
  })
})
