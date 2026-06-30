import { describe, it, expect } from 'vitest'
import { buildGitMcpConfig } from './mcpConfig.js'

describe('buildGitMcpConfig', () => {
  it('returns correct shape', () => {
    const config = buildGitMcpConfig({
      gitMcpJsPath: '/dist/git-mcp.js',
      electronPath: '/usr/bin/electron',
      dataDir: '/data',
      sessionId: 'sess-1',
      base: 'main',
      branch: 'feature',
    })
    const serialized = JSON.stringify(config)
    const parsed = JSON.parse(serialized)
    expect(parsed.mcpServers['slipstream-git'].command).toBe('/usr/bin/electron')
    expect(parsed.mcpServers['slipstream-git'].args).toEqual(['/dist/git-mcp.js'])
    expect(parsed.mcpServers['slipstream-git'].env.SLIPSTREAM_SESSION_ID).toBe('sess-1')
  })

  it('JSON.stringify of result contains NO token key (security assertion)', () => {
    const config = buildGitMcpConfig({
      gitMcpJsPath: '/dist/git-mcp.js',
      electronPath: '/usr/bin/electron',
      dataDir: '/data',
      sessionId: 'sess-1',
      base: 'main',
      branch: 'feature',
    })
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('Token')
  })
})
