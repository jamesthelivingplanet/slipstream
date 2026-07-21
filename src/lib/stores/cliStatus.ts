import { writable } from 'svelte/store'
import type { CliStatusDTO, DiagnosticsDTO } from '../../../electron/shared/contract.js'
import { hasBackend, getCliStatus, getDiagnostics } from '../ipc.js'
import { cleanError } from './errors.js'

// FLO-61: slipstream CLI self-test status, shared between the header dot and the Settings
// Integrations panel so both read the same data without duplicate fetches.
export const cliStatus = writable<CliStatusDTO | null>(null)
export const cliChecking = writable(false)

export async function refreshCliStatus(): Promise<void> {
  if (!hasBackend) return
  cliChecking.set(true)
  try {
    cliStatus.set(await getCliStatus())
  } catch (e) {
    cliStatus.set({ up: false, commands: [], checkedAt: Date.now(), error: cleanError(e) })
  } finally {
    cliChecking.set(false)
  }
}

// FLO-81: Settings → Diagnostics tab data — daemon/version/repo-consistency info.
export const diagnostics = writable<DiagnosticsDTO | null>(null)
export const diagChecking = writable(false)

export async function refreshDiagnostics(): Promise<void> {
  if (!hasBackend) return
  diagChecking.set(true)
  try {
    diagnostics.set(await getDiagnostics())
  } catch {
    diagnostics.set(null)
  } finally {
    diagChecking.set(false)
  }
}
