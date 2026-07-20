import { describe, it, expect } from 'vitest'
import { parseAgentArgs } from './agentCli.js'

describe('parseAgentArgs', () => {
  it('returns [] for undefined/null/empty/whitespace-only input', () => {
    expect(parseAgentArgs(undefined)).toEqual([])
    expect(parseAgentArgs(null)).toEqual([])
    expect(parseAgentArgs('')).toEqual([])
    expect(parseAgentArgs('   \t\n  ')).toEqual([])
  })

  it('splits whitespace-separated flags into tokens', () => {
    expect(parseAgentArgs('--advisor --chrome')).toEqual(['--advisor', '--chrome'])
  })

  it('collapses extra/leading/trailing whitespace', () => {
    expect(parseAgentArgs('   --advisor    --chrome   ')).toEqual(['--advisor', '--chrome'])
  })

  it('keeps a double-quoted value with spaces as one token', () => {
    expect(parseAgentArgs('--msg "hello world"')).toEqual(['--msg', 'hello world'])
  })

  it('keeps a single-quoted value with spaces as one token', () => {
    expect(parseAgentArgs("--msg 'hello world'")).toEqual(['--msg', 'hello world'])
  })

  it('throws a human-readable Error on an unterminated quote', () => {
    expect(() => parseAgentArgs('--bad "unterminated')).toThrow(/unterminated/i)
    expect(() => parseAgentArgs("--bad 'unterminated")).toThrow(/unterminated/i)
  })
})
