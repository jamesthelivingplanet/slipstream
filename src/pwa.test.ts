import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')

describe('PWA assets', () => {
  it('ships a valid web app manifest', () => {
    const raw = readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')
    const manifest = JSON.parse(raw)
    expect(manifest.name).toBe('Slipstream')
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.theme_color).toMatch(/^#/)
    expect(manifest.background_color).toMatch(/^#/)
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose)
    expect(purposes).toContain('any')
    expect(purposes).toContain('maskable')
    for (const icon of manifest.icons) {
      expect(existsSync(resolve(root, 'public', icon.src.replace(/^\//, '')))).toBe(true)
    }
  })

  it('ships a service worker with install/activate/fetch handlers', () => {
    const sw = readFileSync(resolve(root, 'public/sw.js'), 'utf8')
    expect(sw).toContain("addEventListener('install'")
    expect(sw).toContain("addEventListener('activate'")
    expect(sw).toContain("addEventListener('fetch'")
  })

  describe('FLO-150 — push notification action buttons', () => {
    const sw = readFileSync(resolve(root, 'public/sw.js'), 'utf8')

    it('adds action buttons to needs notifications', () => {
      // Approval-shaped asks get quick Approve/Deny; other needs asks get View.
      expect(sw).toContain("action: 'approve'")
      expect(sw).toContain("title: 'Approve'")
      expect(sw).toContain("action: 'deny'")
      expect(sw).toContain("title: 'Deny'")
      expect(sw).toContain("action: 'view'")
      expect(sw).toContain("title: 'View'")
      // Actions are gated on status==='needs' via actionsFor().
      expect(sw).toMatch(/status !== 'needs'/)
      expect(sw).toMatch(/reason === 'approval'/)
    })

    it('wires notificationclick action handling for approve/deny/view', () => {
      expect(sw).toContain("event.action === 'approve'")
      expect(sw).toContain("event.action === 'deny'")
      // A plain body tap (no action) still deep-links via the open-agent path.
      expect(sw).toContain("type: 'open-agent'")
    })

    it('answers approve/deny via the /inline-reply endpoint', () => {
      expect(sw).toContain('/inline-reply')
      // Canned yes/no reply values.
      expect(sw).toMatch(/replyToSession\(sessionId, 'y'\)/)
      expect(sw).toMatch(/replyToSession\(sessionId, 'n'\)/)
    })

    it('stashes reply credentials from the page (set-reply-creds message)', () => {
      expect(sw).toContain("addEventListener('message'")
      expect(sw).toContain("data.type === 'set-reply-creds'")
      // Persists them in IndexedDB so a background click survives app close.
      expect(sw).toContain('indexedDB.open')
    })

    it('falls back to opening the session on reply failure', () => {
      // No stashed creds, auth rejection, or network error all route back to
      // focusOrOpenAgent so the tap is never a silent no-op.
      expect(sw).toContain('focusOrOpenAgent')
    })
  })

  it('links the manifest and apple-touch-icon from index.html', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(html).toContain('rel="manifest"')
    expect(html).toContain('href="/manifest.webmanifest"')
    expect(html).toContain('apple-touch-icon')
    expect(html).toContain('name="theme-color"')
  })

  it('registers the service worker only after window.slipstream is set (web mode)', () => {
    const main = readFileSync(resolve(root, 'src/main.ts'), 'utf8')
    const assignIdx = main.indexOf('.slipstream = api')
    const regIdx = main.indexOf('registerServiceWorker()')
    expect(assignIdx).toBeGreaterThan(-1)
    expect(regIdx).toBeGreaterThan(assignIdx)
  })
})
