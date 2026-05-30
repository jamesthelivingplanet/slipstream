import { writable } from 'svelte/store'

const read = (name: string, fallback: string) =>
  (typeof document !== 'undefined' && document.documentElement.getAttribute(name)) || fallback

export const mode = writable<string>(read('data-mode', 'dark'))
export const accent = writable<string>(read('data-accent', 'violet'))

mode.subscribe((m) => {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-mode', m)
})
accent.subscribe((a) => {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-accent', a)
})

export const ACCENTS: Record<string, string> = {
  violet: '#7c5cff', blue: '#3b82f6', green: '#22c55e',
  orange: '#f97316', rose: '#f43f5e', zinc: '#a1a1aa',
}
