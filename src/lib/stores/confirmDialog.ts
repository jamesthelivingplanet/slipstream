import { writable } from 'svelte/store'

/** In-app replacement for window.confirm — surfaces via <ConfirmDialog />. */
export interface ConfirmRequest {
  title: string
  message: string
  detail?: string // e.g. the dirty/unmerged reason string
  confirmLabel?: string // default "Confirm"
  cancelLabel?: string // default "Cancel"
  danger?: boolean
}
export const confirmState = writable<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(
  null,
)
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => confirmState.set({ ...req, resolve }))
}
