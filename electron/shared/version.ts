// Build-time constants injected via bundler `define` — vite.config.ts (renderer +
// Electron main), scripts/build-server.mjs (daemon/pod), vitest.config.ts (tests).
// See docs/VERSIONING.md for the full scheme.
//
// The `typeof` guards make this module safe to import from any bundle that
// doesn't inject the define (rather than throwing ReferenceError): it just
// degrades to 'unknown'.
declare const __APP_VERSION__: string
declare const __APP_GIT_HASH__: string

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'
export const GIT_SHA = typeof __APP_GIT_HASH__ !== 'undefined' ? __APP_GIT_HASH__ : 'unknown'
