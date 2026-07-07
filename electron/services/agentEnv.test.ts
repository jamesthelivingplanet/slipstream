import { describe, expect, it } from 'vitest'
import { buildAgentEnv } from './agentEnv.js'

describe('buildAgentEnv', () => {
  it('strips the daemon token and internal daemon vars from the inherited env', () => {
    const env = buildAgentEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      SLIPSTREAM_TOKEN: 'secret',
      SLIPSTREAM_PORT: '7421',
      SLIPSTREAM_BIND: '127.0.0.1',
      SLIPSTREAM_DAEMON_URL: 'ws://x/rpc',
      SLIPSTREAM_DAEMON_EPHEMERAL: '1',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env).not.toHaveProperty('SLIPSTREAM_TOKEN')
    expect(env).not.toHaveProperty('SLIPSTREAM_PORT')
    expect(env).not.toHaveProperty('SLIPSTREAM_BIND')
    expect(env).not.toHaveProperty('SLIPSTREAM_DAEMON_URL')
    expect(env).not.toHaveProperty('SLIPSTREAM_DAEMON_EPHEMERAL')
  })

  it('applies per-session overrides on top of the base env', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin', PORT: '1000' }, { PORT: '3742', EXTRA: 'x' })
    expect(env.PORT).toBe('3742')
    expect(env.EXTRA).toBe('x')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('does not let overrides re-introduce scrubbed keys', () => {
    const env = buildAgentEnv({}, { SLIPSTREAM_TOKEN: 'sneaky' })
    expect(env).not.toHaveProperty('SLIPSTREAM_TOKEN')
  })

  it('keeps unrelated SLIPSTREAM_ vars that MCP config wiring may set', () => {
    const env = buildAgentEnv({ SLIPSTREAM_DATA_DIR: '/data' })
    expect(env.SLIPSTREAM_DATA_DIR).toBe('/data')
  })
})
