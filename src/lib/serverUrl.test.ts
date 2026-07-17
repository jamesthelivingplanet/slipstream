import { describe, it, expect } from 'vitest'
import { normalizeServerUrl, rpcWsUrl } from './serverUrl.js'

describe('normalizeServerUrl', () => {
  it('bare host:port defaults to http:', () => {
    expect(normalizeServerUrl('host:7421')).toBe('http://host:7421')
  })

  it('bare host:port with pageProtocol https: prefixes https:', () => {
    expect(normalizeServerUrl('host:7421', 'https:')).toBe('https://host:7421')
  })

  it('full http:// URL is preserved', () => {
    expect(normalizeServerUrl('http://example.com:7421')).toBe('http://example.com:7421')
  })

  it('full https:// URL is preserved', () => {
    expect(normalizeServerUrl('https://example.com')).toBe('https://example.com')
  })

  it('trailing path is stripped down to the origin', () => {
    expect(normalizeServerUrl('https://example.com/some/path')).toBe('https://example.com')
  })

  it('trailing slash is stripped down to the origin', () => {
    expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com')
  })

  it('query string is stripped down to the origin', () => {
    expect(normalizeServerUrl('http://example.com:7421/rpc?token=abc')).toBe(
      'http://example.com:7421',
    )
  })

  it('surrounding whitespace is trimmed', () => {
    expect(normalizeServerUrl('  http://example.com  ')).toBe('http://example.com')
  })

  it('empty string is null', () => {
    expect(normalizeServerUrl('')).toBeNull()
  })

  it('whitespace-only string is null', () => {
    expect(normalizeServerUrl('   ')).toBeNull()
  })

  it('garbage with embedded spaces is null (new URL throws on the space)', () => {
    // `new URL('http://not a url')` throws (invalid host char), so the
    // catch path returns null — this pins down that actual behavior.
    expect(normalizeServerUrl('not a url')).toBeNull()
  })

  it('non-http(s) protocol is null', () => {
    expect(normalizeServerUrl('ftp://x')).toBeNull()
  })

  it('ws:// protocol is null (not http/https)', () => {
    expect(normalizeServerUrl('ws://example.com')).toBeNull()
  })
})

describe('rpcWsUrl', () => {
  it('http origin maps to ws://host/rpc', () => {
    expect(rpcWsUrl('http://h:7421')).toBe('ws://h:7421/rpc')
  })

  it('https origin maps to wss://host/rpc', () => {
    expect(rpcWsUrl('https://h')).toBe('wss://h/rpc')
  })
})
