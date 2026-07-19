import { describe, it, expect } from 'vitest'
import { isAllowedNavigation } from './navigationGuard.js'

describe('isAllowedNavigation', () => {
  describe('http(s) app origin — allow same-origin only', () => {
    const app = 'http://localhost:5173/'

    it('allows the app origin itself', () => {
      expect(isAllowedNavigation('http://localhost:5173/', app)).toBe(true)
    })

    it('allows same-origin SPA routes / paths regardless of trailing slash', () => {
      expect(isAllowedNavigation('http://localhost:5173/index.html', app)).toBe(true)
      expect(isAllowedNavigation('http://localhost:5173/some/spa/route', app)).toBe(true)
      expect(isAllowedNavigation('http://localhost:5173', 'http://localhost:5173/')).toBe(true)
    })

    it('allows a same-origin server redirect (/ -> /index.html)', () => {
      expect(isAllowedNavigation('http://localhost:5173/index.html', app)).toBe(true)
    })

    it('blocks a different host (the XSS / window.location=evil case)', () => {
      expect(isAllowedNavigation('http://evil.example.com/', app)).toBe(false)
      expect(isAllowedNavigation('http://attacker.localhost:5173/', app)).toBe(false)
    })

    it('blocks a different port on the same host', () => {
      expect(isAllowedNavigation('http://localhost:8080/', app)).toBe(false)
      expect(isAllowedNavigation('http://localhost:5174/', app)).toBe(false)
    })

    it('blocks a scheme downgrade/upgrade to https from http app origin', () => {
      expect(isAllowedNavigation('https://localhost:5173/', app)).toBe(false)
    })

    it('blocks data:/blob:/javascript: URLs', () => {
      expect(isAllowedNavigation('data:text/html,<script>steal()</script>', app)).toBe(false)
      expect(isAllowedNavigation('blob:http://localhost:5173/abc', app)).toBe(false)
      expect(isAllowedNavigation('javascript:alert(1)', app)).toBe(false)
    })

    it('works for an https app origin too', () => {
      const httpsApp = 'https://app.example.com'
      expect(isAllowedNavigation('https://app.example.com/dashboard', httpsApp)).toBe(true)
      expect(isAllowedNavigation('https://evil.example.com/', httpsApp)).toBe(false)
      expect(isAllowedNavigation('http://app.example.com/', httpsApp)).toBe(false)
    })
  })

  describe('file:// app origin — require exact app path', () => {
    const app = 'file:///opt/slipstream/dist/index.html'

    it('allows the app file itself', () => {
      expect(isAllowedNavigation('file:///opt/slipstream/dist/index.html', app)).toBe(true)
    })

    it('blocks a different local file (downloaded/local doc)', () => {
      expect(isAllowedNavigation('file:///home/user/Downloads/evil.html', app)).toBe(false)
      expect(isAllowedNavigation('file:///opt/slipstream/dist/other.html', app)).toBe(false)
    })

    it('blocks http(s)/data URLs even when they look local', () => {
      expect(isAllowedNavigation('http://localhost:5173/', app)).toBe(false)
      expect(isAllowedNavigation('data:text/html,hi', app)).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('denies an unparseable target', () => {
      expect(isAllowedNavigation('not a url', 'http://localhost:5173/')).toBe(false)
    })

    it('denies when the app url itself is unparseable', () => {
      expect(isAllowedNavigation('http://localhost:5173/', 'not a url')).toBe(false)
    })

    it('denies a non-http(s)/file app origin (e.g. data: app url)', () => {
      expect(isAllowedNavigation('data:text/html,x', 'data:text/html,x')).toBe(false)
    })

    it('treats file:// origin compare as NOT sufficient (opaque null origin)', () => {
      // Two different files must not be considered same-origin just because
      // file:// origins stringify to 'null'.
      expect(isAllowedNavigation('file:///a/b.html', 'file:///a/b.html')).toBe(true)
      expect(isAllowedNavigation('file:///a/c.html', 'file:///a/b.html')).toBe(false)
    })
  })
})
