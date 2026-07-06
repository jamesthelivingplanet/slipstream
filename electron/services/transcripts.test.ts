import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasTranscript, transcriptPathFor } from './transcripts.js'

let projectsDir: string

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'slipstream-transcripts-'))
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
    expect(hasTranscript('any-id', '/tmp/slipstream-does-not-exist-xyz')).toBe(false)
  })
})

describe('transcriptPathFor', () => {
  it('returns the resolved path when the transcript exists', () => {
    const id = 'path-id'
    const subDir = join(projectsDir, 'proj')
    mkdirSync(subDir)
    writeFileSync(join(subDir, `${id}.jsonl`), '{}')
    expect(transcriptPathFor(id, projectsDir)).toBe(join(subDir, `${id}.jsonl`))
  })

  it('returns null when no matching transcript exists', () => {
    expect(transcriptPathFor('nope', projectsDir)).toBeNull()
    expect(transcriptPathFor('nope', '/tmp/slipstream-does-not-exist-xyz')).toBeNull()
  })
})
