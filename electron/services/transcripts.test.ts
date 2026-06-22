import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasTranscript } from './transcripts.js'

let projectsDir: string

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'flotilla-transcripts-'))
})

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true })
})

describe('hasTranscript', () => {
  it('returns true when <projectsDir>/<sub>/<id>.jsonl exists', () => {
    const id = 'abc-123'
    const subDir = join(projectsDir, 'some-project')
    mkdirSync(subDir)
    writeFileSync(join(subDir, `${id}.jsonl`), '{}')
    expect(hasTranscript(id, projectsDir)).toBe(true)
  })

  it('returns false when no matching file exists', () => {
    mkdirSync(join(projectsDir, 'some-project'))
    expect(hasTranscript('nonexistent-uuid', projectsDir)).toBe(false)
  })

  it('returns false when projectsDir does not exist', () => {
    expect(hasTranscript('any-id', '/tmp/flotilla-does-not-exist-xyz')).toBe(false)
  })
})
