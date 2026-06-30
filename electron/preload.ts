import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from './shared/contract.js'

const arg = process.argv.find((a) => a.startsWith('--slipstream-daemon='))
const daemon = arg
  ? (JSON.parse(
      Buffer.from(arg.slice('--slipstream-daemon='.length), 'base64').toString(),
    ) as { url: string; token: string })
  : null

contextBridge.exposeInMainWorld('__slipstreamDaemon', daemon)
contextBridge.exposeInMainWorld('__slipstreamNative', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickRepo),
})
