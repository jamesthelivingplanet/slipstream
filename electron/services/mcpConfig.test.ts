import { describe, it, expect } from 'vitest'
import { buildAppMcpConfig, buildOpencodeMcpConfig } from './mcpConfig.js'

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

describe('buildOpencodeMcpConfig', () => {
  it('returns correct shape', () => {
    const config = buildOpencodeMcpConfig({
      appMcpJsPath: '/dist/app-mcp.js',
      electronPath: '/usr/bin/electron',
      dataDir: '/data',
      sessionId: 'sess-1',
      base: 'main',
      branch: 'feature',
    })
    expect(config.mcp.slipstream.type).toBe('local')
    expect(config.mcp.slipstream.command).toEqual(['/usr/bin/electron', '/dist/app-mcp.js'])
    expect(config.mcp.slipstream.enabled).toBe(true)
    expect(config.mcp.slipstream.environment).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SLIPSTREAM_DATA_DIR: '/data',
      SLIPSTREAM_SESSION_ID: 'sess-1',
      SLIPSTREAM_BASE: 'main',
      SLIPSTREAM_BRANCH: 'feature',
    })
  })
})
