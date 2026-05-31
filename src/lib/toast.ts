import { writable } from 'svelte/store'

export const toasts = writable<{ id: string; type: 'success' | 'error'; message: string }[]>([])

export function pushToast(type: 'success' | 'error', message: string): void {
  const id = crypto.randomUUID()
  toasts.update(($t) => [...$t, { id, type, message }])
  setTimeout(() => dismissToast(id), 4000)
}

export function dismissToast(id: string): void {
  toasts.update(($t) => $t.filter((t) => t.id !== id))
}
