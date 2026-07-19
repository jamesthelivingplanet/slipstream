import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from './shared/contract.js'
import { isAllowedNavigation } from './shared/navigationGuard.js'

const daemonArg = process.argv.find((a) => a.startsWith('--slipstream-daemon='))
const daemon = daemonArg
  ? (JSON.parse(
      Buffer.from(daemonArg.slice('--slipstream-daemon='.length), 'base64').toString(),
    ) as {
      url: string
      token: string
      reused?: boolean
    } | null)
  : null

// Defense in depth (FLO-127): the main process cancels any top-level
// navigation/redirect off the app origin via `will-navigate`/`will-redirect`,
// so this preload should never re-run on a foreign document. But if a
// navigation ever slips through (or a future regression reintroduces one),
// refuse to expose the daemon URL + bearer token — or any native bridge — to a
// document whose URL isn't the app's. With `daemon` left null the renderer
// falls back to web mode instead of leaking the credential.
const appUrlArg = process.argv.find((a) => a.startsWith('--slipstream-app-url='))
const appUrl = appUrlArg ? appUrlArg.slice('--slipstream-app-url='.length) : null
const trusted = appUrl ? isAllowedNavigation(location.href, appUrl) : false

contextBridge.exposeInMainWorld('__slipstreamDaemon', trusted ? daemon : null)
contextBridge.exposeInMainWorld(
  '__slipstreamNative',
  trusted
    ? {
        pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickRepo),
      }
    : null,
)
