import { describe, it, expect, vi } from 'vitest'
import { handleRpc } from './gitMcp.js'
import type { GitMcpDeps } from './gitMcp.js'

function makeDeps(overrides: Partial<GitMcpDeps> = {}): GitMcpDeps {
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
    ...overrides,
  }
}

describe('handleRpc', () => {
  it('returns correct protocolVersion for initialize', async () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    const res = await handleRpc(msg, makeDeps()) as { id: number; result: { protocolVersion: string } }
    expect(res).not.toBeNull()
    expect((res as any).result.protocolVersion).toBe('2024-11-05')
  })

  it('returns null for notification (no id)', async () => {
    const msg = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }
    const res = await handleRpc(msg, makeDeps())
    expect(res).toBeNull()
  })

  it('tools/list returns 1 tool', async () => {
    const msg = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    const res = await handleRpc(msg, makeDeps()) as any
    expect(res.result.tools).toHaveLength(1)
    expect(res.result.tools[0].name).toBe('open_merge_request')
  })

  it('unknown method returns error -32601', async () => {
    const msg = { jsonrpc: '2.0', id: 3, method: 'unknown/method', params: {} }
    const res = await handleRpc(msg, makeDeps()) as any
    expect(res.error.code).toBe(-32601)
  })

  it('tools/call open_merge_request calls openMergeRequest and writeSentinel', async () => {
    const deps = makeDeps()
    const msg = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'open_merge_request', arguments: { title: 'My PR' } } }
    const res = await handleRpc(msg, deps) as any
    expect(deps.push).toHaveBeenCalled()
    expect(deps.openMergeRequest).toHaveBeenCalled()
    expect(deps.writeSentinel).toHaveBeenCalledWith('https://example.com/mr/1')
    expect(res.result.content[0].text).toContain('https://example.com/mr/1')
  })

  it('tools/call open_merge_request still succeeds when push fails (best-effort)', async () => {
    const deps = makeDeps({ push: vi.fn().mockRejectedValue(new Error('already up to date')) })
    const msg = { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'open_merge_request', arguments: { title: 'My PR' } } }
    const res = await handleRpc(msg, deps) as any
    expect(res.error).toBeUndefined()
    expect(res.result.isError).toBeFalsy()
    expect(deps.openMergeRequest).toHaveBeenCalled()
    expect(deps.writeSentinel).toHaveBeenCalledWith('https://example.com/mr/1')
    expect(res.result.content[0].text).toContain('https://example.com/mr/1')
  })
})
