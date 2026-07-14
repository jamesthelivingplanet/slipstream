import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findOnPath, binForKind, PI_BIN_NAME } from './cliProbe.js'

describe('findOnPath', () => {
  let dir: string
  let binPath: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-'))
    binPath = path.join(dir, 'fake-agent-cli')
    writeFileSync(binPath, '#!/bin/sh\necho hi\n')
    chmodSync(binPath, 0o755)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a binary when its directory is on PATH', () => {
    const found = findOnPath('fake-agent-cli', { PATH: dir })
    expect(found).toBe(binPath)
  })

  it('returns null when the binary is not on PATH', () => {
    const found = findOnPath('fake-agent-cli', { PATH: '/definitely/not/a/real/dir' })
    expect(found).toBeNull()
  })

  it('returns null for an empty PATH', () => {
    expect(findOnPath('fake-agent-cli', {})).toBeNull()
  })

  it('checks each PATH entry in order and finds the binary among several dirs', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-other-'))
    try {
      const combined = [other, dir].join(path.delimiter)
      expect(findOnPath('fake-agent-cli', { PATH: combined })).toBe(binPath)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('does not match a directory that happens to share the binary name', () => {
    const trickyDir = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-tricky-'))
    try {
      // Make a directory (not a file) named after the binary inside trickyDir's parent PATH entry.
      const asDir = path.join(trickyDir, 'fake-agent-cli')
      mkdtempSync(asDir + '-') // just ensure trickyDir exists; asDir itself is never created as a dir here
      expect(findOnPath('fake-agent-cli', { PATH: trickyDir })).toBeNull()
    } finally {
      rmSync(trickyDir, { recursive: true, force: true })
    }
  })
})

describe('binForKind', () => {
  it('maps claude-code to the claude binary', () => {
    expect(binForKind('claude-code')).toBe('claude')
  })

  it('maps opencode to the opencode binary', () => {
    expect(binForKind('opencode')).toBe('opencode')
  })

  it('maps pi to the pi binary', () => {
    expect(binForKind('pi')).toBe(PI_BIN_NAME)
    expect(PI_BIN_NAME).toBe('pi')
  })

  it('maps antigravity to the agy binary', () => {
    expect(binForKind('antigravity')).toBe('agy')
  })

  it('maps grok to the grok binary', () => {
    expect(binForKind('grok')).toBe('grok')
  })
})
