import { describe, it, expect, vi } from 'vitest'
import { handleRpc } from './appMcp.js'
import type { AppMcpDeps, JsonRpcResponse, McpTool, McpToolResult } from './appMcp.js'

function makeDeps(overrides: Partial<AppMcpDeps> = {}): AppMcpDeps {
  return {
    cwd: '/cwd',
    dataDir: '/data',
    sessionId: 'sess-1',
    base: 'main',
    branch: 'feature',
    getToken: vi.fn().mockReturnValue('tok'),
    push: vi.fn().mockResolvedValue(undefined),
    openMergeRequest: vi.fn().mockResolvedValue({ url: 'https://example.com/mr/1', isNew: true }),
    getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
    writeSentinel: vi.fn().mockResolvedValue(undefined),
    writeStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('handleRpc', () => {
  it('returns correct protocolVersion for initialize', async () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    const res = (await handleRpc(msg, makeDeps())) as JsonRpcResponse<{ protocolVersion: string }>
    expect(res).not.toBeNull()
    expect(res.result?.protocolVersion).toBe('2024-11-05')
  })

  it('returns null for notification (no id)', async () => {
    const msg = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }
    const res = await handleRpc(msg, makeDeps())
    expect(res).toBeNull()
  })

  it('tools/list returns 2 tools', async () => {
    const msg = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    const res = (await handleRpc(msg, makeDeps())) as JsonRpcResponse<{ tools: McpTool[] }>
    expect(res.result?.tools).toHaveLength(2)
    const names = (res.result?.tools ?? []).map((t) => t.name)
    expect(names).toContain('open_merge_request')
    expect(names).toContain('report_status')
  })

  it('unknown method returns error -32601', async () => {
    const msg = { jsonrpc: '2.0', id: 3, method: 'unknown/method', params: {} }
    const res = (await handleRpc(msg, makeDeps())) as JsonRpcResponse
    expect(res.error?.code).toBe(-32601)
  })

  it('tools/call open_merge_request calls openMergeRequest and writeSentinel', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'open_merge_request', arguments: { title: 'My PR' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.push).toHaveBeenCalled()
    expect(deps.openMergeRequest).toHaveBeenCalled()
    expect(deps.writeSentinel).toHaveBeenCalledWith('https://example.com/mr/1')
    expect(res.result?.content[0].text).toContain('https://example.com/mr/1')
  })

  it('tools/call open_merge_request still succeeds when push fails (best-effort)', async () => {
    const deps = makeDeps({ push: vi.fn().mockRejectedValue(new Error('already up to date')) })
    const msg = {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'open_merge_request', arguments: { title: 'My PR' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(res.error).toBeUndefined()
    expect(res.result?.isError).toBeFalsy()
    expect(deps.openMergeRequest).toHaveBeenCalled()
    expect(deps.writeSentinel).toHaveBeenCalledWith('https://example.com/mr/1')
    expect(res.result?.content[0].text).toContain('https://example.com/mr/1')
  })

  it('tools/call report_status calls writeStatus and returns success text containing the state', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'report_status', arguments: { state: 'needs', message: 'blocked' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeStatus).toHaveBeenCalledWith('needs', 'blocked')
    expect(res.result?.isError).toBeFalsy()
    expect(res.result?.content[0].text).toContain('needs')
  })

  it('tools/call report_status with invalid state returns a tool error and does not call writeStatus', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'report_status', arguments: { state: 'bogus' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeStatus).not.toHaveBeenCalled()
    expect(res.result?.isError).toBe(true)
  })

  it('tools/call report_status with only state works (message undefined)', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'report_status', arguments: { state: 'done' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeStatus).toHaveBeenCalledWith('done', undefined)
    expect(res.result?.isError).toBeFalsy()
    expect(res.result?.content[0].text).toContain('done')
  })
})
