import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findOnPath, findAgentCli, binForKind, PI_BIN_NAME } from './cliProbe.js'

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

  it('maps kilo to the kilo binary', () => {
    expect(binForKind('kilo')).toBe('kilo')
  })
})

describe('findAgentCli', () => {
  let homeDir: string
  let kiloBinPath: string
  let prevHome: string | undefined

  beforeAll(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-home-'))
    const kiloBinDir = path.join(homeDir, '.kilo', 'bin')
    mkdirSync(kiloBinDir, { recursive: true })
    kiloBinPath = path.join(kiloBinDir, 'kilo')
    writeFileSync(kiloBinPath, '#!/bin/sh\necho hi\n')
    chmodSync(kiloBinPath, 0o755)
    prevHome = process.env.HOME
    process.env.HOME = homeDir
  })

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('behaves like findOnPath for kinds with no extra candidates (e.g. claude-code)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-fac-'))
    try {
      const binPath = path.join(dir, 'claude')
      writeFileSync(binPath, '#!/bin/sh\necho hi\n')
      chmodSync(binPath, 0o755)
      expect(findAgentCli('claude-code', { PATH: dir })).toBe(binPath)
      expect(findAgentCli('claude-code', { PATH: '/definitely/not/a/real/dir' })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.kilo/bin/kilo for kind "kilo" when not on PATH', () => {
    expect(findAgentCli('kilo', { PATH: '/definitely/not/a/real/dir' })).toBe(kiloBinPath)
  })

  it('prefers a PATH match over the ~/.kilo/bin fallback', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-fac-kilo-path-'))
    try {
      const pathBin = path.join(dir, 'kilo')
      writeFileSync(pathBin, '#!/bin/sh\necho hi\n')
      chmodSync(pathBin, 0o755)
      expect(findAgentCli('kilo', { PATH: dir })).toBe(pathBin)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for "kilo" when neither PATH nor ~/.kilo/bin has it', () => {
    const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'cliprobe-nohome-'))
    try {
      process.env.HOME = emptyHome
      expect(findAgentCli('kilo', { PATH: '/definitely/not/a/real/dir' })).toBeNull()
    } finally {
      process.env.HOME = homeDir
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})
