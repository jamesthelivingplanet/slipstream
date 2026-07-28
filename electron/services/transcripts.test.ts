import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasTranscript,
  transcriptPathFor,
  subagentsDirFor,
  subagentTranscriptFiles,
} from './transcripts.js'

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

describe('subagentsDirFor', () => {
  it('returns the resolved path when <projectsDir>/<sub>/<id>/subagents exists', () => {
    const id = 'sess-1'
    const subDir = join(projectsDir, 'proj')
    mkdirSync(join(subDir, id, 'subagents'), { recursive: true })
    expect(subagentsDirFor(id, projectsDir)).toBe(join(subDir, id, 'subagents'))
  })

  it('returns null when there is a main transcript but no subagents dir', () => {
    const id = 'sess-2'
    const subDir = join(projectsDir, 'proj')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, `${id}.jsonl`), '{}')
    expect(subagentsDirFor(id, projectsDir)).toBeNull()
  })

  it('returns null when projectsDir does not exist', () => {
    expect(subagentsDirFor('any-id', '/tmp/slipstream-does-not-exist-xyz')).toBeNull()
  })
})

describe('subagentTranscriptFiles', () => {
  it('lists agent-*.jsonl files with their sibling meta.json path', () => {
    const id = 'sess-3'
    const dir = join(projectsDir, 'proj', id, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-a111.jsonl'), '{}')
    writeFileSync(join(dir, 'agent-a111.meta.json'), '{"toolUseId":"toolu_1"}')
    writeFileSync(join(dir, 'agent-a222.jsonl'), '{}')
    // no meta.json for a222

    const files = subagentTranscriptFiles(id, projectsDir).sort((a, b) =>
      a.agentId.localeCompare(b.agentId),
    )

    expect(files).toHaveLength(2)
    expect(files[0]).toEqual({
      agentId: 'a111',
      jsonlPath: join(dir, 'agent-a111.jsonl'),
      metaPath: join(dir, 'agent-a111.meta.json'),
    })
    expect(files[1]).toEqual({
      agentId: 'a222',
      jsonlPath: join(dir, 'agent-a222.jsonl'),
      metaPath: null,
    })
  })

  it('ignores non-matching files in the subagents dir', () => {
    const id = 'sess-4'
    const dir = join(projectsDir, 'proj', id, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-a111.jsonl'), '{}')
    writeFileSync(join(dir, 'agent-a111.meta.json'), '{}')
    writeFileSync(join(dir, 'not-an-agent-file.txt'), 'noise')

    const files = subagentTranscriptFiles(id, projectsDir)
    expect(files).toHaveLength(1)
    expect(files[0].agentId).toBe('a111')
  })

  it('returns [] when there is no subagents dir', () => {
    expect(subagentTranscriptFiles('nope', projectsDir)).toEqual([])
  })

  it('returns [] when projectsDir does not exist', () => {
    expect(subagentTranscriptFiles('any-id', '/tmp/slipstream-does-not-exist-xyz')).toEqual([])
  })
})
