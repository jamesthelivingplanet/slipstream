/**
 * Unit tests for withTrustedDir (pure function only — no fs IO).
 */

import { describe, it, expect } from 'vitest'
import { withTrustedDir } from './claudeTrust.js'

describe('withTrustedDir', () => {
  it('creates projects and the dir entry when config is empty', () => {
    const result = withTrustedDir({}, '/some/dir')
    expect(result).toEqual({
      projects: {
        '/some/dir': { hasTrustDialogAccepted: true },
      },
    })
  })

  it('preserves an existing unrelated top-level key', () => {
    const result = withTrustedDir({ numStartups: 5 }, '/some/dir')
    expect(result.numStartups).toBe(5)
    expect((result.projects as Record<string, unknown>)['/some/dir']).toEqual({
      hasTrustDialogAccepted: true,
    })
  })

  it('preserves an existing unrelated key inside projects[dir]', () => {
    const config = {
      projects: {
        '/some/dir': { someOtherFlag: 'hello' },
      },
    }
    const result = withTrustedDir(config, '/some/dir')
    const entry = (result.projects as Record<string, Record<string, unknown>>)['/some/dir']
    expect(entry.someOtherFlag).toBe('hello')
    expect(entry.hasTrustDialogAccepted).toBe(true)
  })

  it('preserves sibling project entries', () => {
    const config = {
      projects: {
        '/other/dir': { hasTrustDialogAccepted: true },
      },
    }
    const result = withTrustedDir(config, '/some/dir')
    const projects = result.projects as Record<string, unknown>
    expect(projects['/other/dir']).toEqual({ hasTrustDialogAccepted: true })
    expect(projects['/some/dir']).toEqual({ hasTrustDialogAccepted: true })
  })

  it('is idempotent — applying twice equals applying once', () => {
    const once = withTrustedDir({}, '/some/dir')
    const twice = withTrustedDir(once, '/some/dir')
    expect(twice).toEqual(once)
  })

  it('does not mutate the input object', () => {
    const config: Record<string, unknown> = { projects: {} }
    const projectsBefore = config.projects
    withTrustedDir(config, '/some/dir')
    expect(config.projects).toBe(projectsBefore)
    expect((config.projects as Record<string, unknown>)['/some/dir']).toBeUndefined()
  })
})
