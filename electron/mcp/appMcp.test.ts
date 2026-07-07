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
    writeOutcome: vi.fn().mockResolvedValue(undefined),
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

  it('tools/list returns 3 tools', async () => {
    const msg = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    const res = (await handleRpc(msg, makeDeps())) as JsonRpcResponse<{ tools: McpTool[] }>
    expect(res.result?.tools).toHaveLength(3)
    const names = (res.result?.tools ?? []).map((t) => t.name)
    expect(names).toContain('open_merge_request')
    expect(names).toContain('report_status')
    expect(names).toContain('report_outcome')
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

  it('tools/call report_outcome calls writeOutcome and returns success text containing the result', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'report_outcome',
        arguments: { result: 'success', summary: 'Fixed the login bug', details: 'notes' },
      },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeOutcome).toHaveBeenCalledWith('success', 'Fixed the login bug', 'notes')
    expect(res.result?.isError).toBeFalsy()
    expect(res.result?.content[0].text).toContain('success')
  })

  it('tools/call report_outcome works without details (optional)', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'report_outcome',
        arguments: { result: 'partial', summary: 'Some progress' },
      },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeOutcome).toHaveBeenCalledWith('partial', 'Some progress', undefined)
    expect(res.result?.isError).toBeFalsy()
  })

  it('tools/call report_outcome with invalid result returns a tool error and does not call writeOutcome', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'report_outcome', arguments: { result: 'bogus', summary: 'x' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeOutcome).not.toHaveBeenCalled()
    expect(res.result?.isError).toBe(true)
  })

  it('tools/call report_outcome with missing summary returns a tool error and does not call writeOutcome', async () => {
    const deps = makeDeps()
    const msg = {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'report_outcome', arguments: { result: 'success' } },
    }
    const res = (await handleRpc(msg, deps)) as JsonRpcResponse<McpToolResult>
    expect(deps.writeOutcome).not.toHaveBeenCalled()
    expect(res.result?.isError).toBe(true)
  })

  it('tools/call report_outcome truncates an over-long summary', async () => {
    const deps = makeDeps()
    const longSummary = 'x'.repeat(5000)
    const msg = {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'report_outcome', arguments: { result: 'success', summary: longSummary } },
    }
    await handleRpc(msg, deps)
    const call = (deps.writeOutcome as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1]).toHaveLength(4000)
  })
})
