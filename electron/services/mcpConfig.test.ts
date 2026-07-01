import { describe, it, expect } from 'vitest'
import { buildAppMcpConfig } from './mcpConfig.js'

describe('buildAppMcpConfig', () => {
  it('returns correct shape', () => {
    const config = buildAppMcpConfig({
      appMcpJsPath: '/dist/app-mcp.js',
      electronPath: '/usr/bin/electron',
      dataDir: '/data',
      sessionId: 'sess-1',
      base: 'main',
      branch: 'feature',
    })
    const serialized = JSON.stringify(config)
    const parsed = JSON.parse(serialized)
    expect(parsed.mcpServers['slipstream'].command).toBe('/usr/bin/electron')
    expect(parsed.mcpServers['slipstream'].args).toEqual(['/dist/app-mcp.js'])
    expect(parsed.mcpServers['slipstream'].env.SLIPSTREAM_SESSION_ID).toBe('sess-1')
  })

  it('JSON.stringify of result contains NO token key (security assertion)', () => {
    const config = buildAppMcpConfig({
      appMcpJsPath: '/dist/app-mcp.js',
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
