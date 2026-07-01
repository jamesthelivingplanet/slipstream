import { describe, it, expect } from 'vitest'
import { buildHealthRequests, interpretResponses } from './mcpHealth.js'

describe('buildHealthRequests', () => {
  it('returns two valid JSON-RPC request lines', () => {
    const lines = buildHealthRequests()
    expect(lines).toHaveLength(2)

    const [initLine, toolsLine] = lines
    const init = JSON.parse(initLine)
    const tools = JSON.parse(toolsLine)

    expect(init.jsonrpc).toBe('2.0')
    expect(init.id).toBe(1)
    expect(init.method).toBe('initialize')
    expect(init.params.protocolVersion).toBe('2024-11-05')

    expect(tools.jsonrpc).toBe('2.0')
    expect(tools.id).toBe(2)
    expect(tools.method).toBe('tools/list')
  })
})

describe('interpretResponses', () => {
  it('extracts serverName, protocolVersion, and tools from valid responses', () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'slipstream', version: '1.0.0' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'open_merge_request' }, { name: 'report_status' }] } }),
    ]

    const result = interpretResponses(lines)
    expect(result.serverName).toBe('slipstream')
    expect(result.protocolVersion).toBe('2024-11-05')
    expect(result.tools).toEqual(['open_merge_request', 'report_status'])
  })

  it('tolerates junk and unparseable lines', () => {
    const lines = [
      'not json',
      '',
      '   ',
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'slipstream' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), // notification, no id/result
      '{"broken":',
    ]

    const result = interpretResponses(lines)
    expect(result.serverName).toBe('slipstream')
    expect(result.tools).toEqual([])
  })

  it('returns tools: [] when tools/list response is missing', () => {
    const result = interpretResponses([
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'slipstream' }, protocolVersion: '2024-11-05' } }),
    ])

    expect(result.tools).toEqual([])
    expect(result.serverName).toBe('slipstream')
    expect(result.protocolVersion).toBe('2024-11-05')
  })

  it('returns empty result for empty input', () => {
    const result = interpretResponses([])
    expect(result).toEqual({ tools: [] })
  })
})
