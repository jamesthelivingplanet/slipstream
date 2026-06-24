import { describe, it, expect } from 'vitest'
import { parseEditorCommand } from './editorLauncher.js'

describe('parseEditorCommand', () => {
  it('simple command: code → bin=code, args=[path]', () => {
    const { bin, args } = parseEditorCommand('code', '/home/user/project')
    expect(bin).toBe('code')
    expect(args).toEqual(['/home/user/project'])
  })

  it('command with args: code serve-web → bin=code, args=[serve-web, path]', () => {
    const { bin, args } = parseEditorCommand('code serve-web', '/home/user/project')
    expect(bin).toBe('code')
    expect(args).toEqual(['serve-web', '/home/user/project'])
  })

  it('trims extra whitespace', () => {
    const { bin, args } = parseEditorCommand('  zed  ', '/my/path')
    expect(bin).toBe('zed')
    expect(args).toEqual(['/my/path'])
  })

  it('throws for blank command', () => {
    expect(() => parseEditorCommand('', '/some/path')).toThrow('No editor command configured')
  })

  it('throws for whitespace-only command', () => {
    expect(() => parseEditorCommand('   ', '/some/path')).toThrow('No editor command configured')
  })
})
