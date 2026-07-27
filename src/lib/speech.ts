// Dictation bridge (FLO-155) — voice-to-text for the mobile terminal
// composer, with two independent backends behind one API.
//
// Same rationale as haptics.ts/push.ts: the mobile app's WebView loads this
// SAME SPA over the tailnet — there is no separate mobile build. Inside the
// Capacitor shell, window.Capacitor (and window.Capacitor.Plugins) is
// injected into the page at runtime; a plain browser, the installed PWA, or
// the Electron renderer never set window.Capacitor. So this module
// feature-detects the native plugin rather than importing @capacitor/* —
// src/ must stay free of any @capacitor/* npm dependency (a browser tab
// loading this same bundle must never even attempt to resolve it). The
// @capacitor-community/speech-recognition package itself lives only in
// mobile/'s native dependency set, wired into the Android build via
// `cap sync`.
//
// The native plugin is preferred whenever it's present: Android WebViews
// have no usable Web Speech API (the underlying Chromium build ships without
// a working speech backend, and there's no OS-level bridge for it the way
// there is for a real Chrome tab), so `SpeechRecognition` /
// `webkitSpeechRecognition` are simply undefined there. The browser Web
// Speech API fallback below only ever actually engages for the PWA /
// desktop-browser case — a real Chrome/Edge tab, or the installed PWA
// running under one.

// ── Native plugin shape (@capacitor-community/speech-recognition) ──────────
// Declared locally, mirroring haptics.ts's pattern, so this file never
// imports the @capacitor/* package itself.

interface NativeSpeechRecognitionPlugin {
  available(): Promise<{ available: boolean }>
  start(opts: {
    language?: string
    maxResults?: number
    partialResults?: boolean
    popup?: boolean
  }): Promise<{ matches?: string[] }>
  stop(): Promise<void>
  isListening(): Promise<{ listening: boolean }>
  checkPermissions(): Promise<{
    speechRecognition: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  }>
  requestPermissions(): Promise<{
    speechRecognition: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  }>
  addListener(
    eventName: 'partialResults',
    listenerFunc: (data: { matches: string[] }) => void,
  ): Promise<{ remove(): Promise<void> }>
  addListener(
    eventName: 'listeningState',
    listenerFunc: (data: { status: 'started' | 'stopped' }) => void,
  ): Promise<{ remove(): Promise<void> }>
}

interface CapacitorGlobal {
  isPluginAvailable?(name: string): boolean
  Plugins?: {
    SpeechRecognition?: NativeSpeechRecognitionPlugin
  }
}

function cap(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** True only inside the Capacitor mobile shell — mirrors haptics.ts's
 *  hapticsAvailable(). Does not confirm the OS-level recognizer actually
 *  works (that's what plugin.available() is for, checked inside
 *  startDictation before committing to the native path). */
export function nativeDictationAvailable(): boolean {
  return typeof window !== 'undefined' && !!cap()?.isPluginAvailable?.('SpeechRecognition')
}

function nativePlugin(): NativeSpeechRecognitionPlugin | undefined {
  return nativeDictationAvailable() ? cap()?.Plugins?.SpeechRecognition : undefined
}

// ── Web Speech API shape ────────────────────────────────────────────────────
// Minimal local declarations — lib.dom doesn't ship these (Web Speech API is
// not part of the standard DOM lib), so we declare exactly what this module
// needs rather than pulling in a third-party ambient types package.

export interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

export interface SpeechRecognitionResult {
  length: number
  isFinal: boolean
  0: SpeechRecognitionAlternative
}

export interface SpeechResultList {
  length: number
  [index: number]: SpeechRecognitionResult
}

export interface SpeechRecognitionEvent {
  results: SpeechResultList
}

export interface SpeechRecognitionErrorEvent {
  error: string
}

export interface SpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

/** True when a browser-native Web Speech API recognizer constructor exists.
 *  In practice this is Chrome/Edge (webkit-prefixed) and never Android's
 *  in-app WebView — see the file header. */
export function webDictationAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    (typeof window.SpeechRecognition === 'function' ||
      typeof window.webkitSpeechRecognition === 'function')
  )
}

/** Synchronous, throw-free availability check — used by the composer to
 *  decide whether to render the mic button at all. Never confirms the
 *  native plugin's runtime `available()` (that's async); a device that
 *  reports the plugin present but unavailable at runtime still falls back
 *  to the web backend inside startDictation(). */
export function dictationAvailable(): boolean {
  return nativeDictationAvailable() || webDictationAvailable()
}

// ── Transcript helpers ──────────────────────────────────────────────────────

/** Append `text` onto `base`, normalizing whitespace at the join so callers
 *  never have to think about whether either side already carries a space. */
export function appendTranscript(base: string, text: string): string {
  const t = text.trim()
  if (t === '') return base
  if (base === '') return t
  if (/\s$/.test(base)) return base + t
  return base + ' ' + t
}

/** Reduce a Web Speech API results list (interim + final entries) into one
 *  normalized "best so far" string, matching the replace-everything contract
 *  of DictationHandlers.onTranscript regardless of how the engine spaces its
 *  individual transcript segments. */
export function transcriptFromResults(results: SpeechResultList): string {
  let out = ''
  for (let i = 0; i < results.length; i++) {
    out = appendTranscript(out, results[i][0].transcript)
  }
  return out
}

/** Map a raw error code (native `requestPermissions`/Web Speech API
 *  `event.error`) to a human-readable toast message. `''` marks a benign
 *  condition the caller should show no toast for. */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied'
    case 'audio-capture':
      return 'No microphone available'
    case 'network':
      return 'Speech recognition service unreachable'
    case 'no-speech':
    case 'aborted':
      return ''
    default:
      return `Dictation failed (${code})`
  }
}

// ── Public session API ──────────────────────────────────────────────────────

export interface DictationHandlers {
  /** Best-so-far transcript for this dictation, REPLACING anything reported
   *  before — never an incremental delta. */
  onTranscript(text: string): void
  /** Dictation ended. `error` is a human-readable message when abnormal. */
  onEnd(error?: string): void
}

export interface DictationSession {
  stop(): void
}

async function startNativeDictation(handlers: DictationHandlers): Promise<DictationSession> {
  const plugin = nativePlugin()
  // nativeDictationAvailable() already confirmed the plugin is registered;
  // this is just a defensive narrow for TS since startDictation calls this
  // only after re-checking availability itself.
  if (!plugin) throw new Error('Dictation is not supported on this device')

  let ended = false
  let watchdog: ReturnType<typeof setInterval> | undefined = undefined
  let partialHandle: { remove(): Promise<void> } | undefined = undefined
  let listeningHandle: { remove(): Promise<void> } | undefined = undefined

  const end = (error?: string) => {
    if (ended) return
    ended = true
    if (watchdog !== undefined) clearInterval(watchdog)
    partialHandle?.remove().catch(() => {})
    listeningHandle?.remove().catch(() => {})
    handlers.onEnd(error)
  }

  const perm = await plugin.checkPermissions()
  let granted = perm.speechRecognition === 'granted'
  if (!granted) {
    const requested = await plugin.requestPermissions()
    granted = requested.speechRecognition === 'granted'
  }
  if (!granted) throw new Error('Microphone permission denied')

  // The Android plugin emits the FULL current utterance on every
  // partialResults event, including the final one — that is exactly the
  // replace-everything semantics DictationHandlers.onTranscript expects, so
  // no delta-tracking is needed here.
  partialHandle = await plugin.addListener('partialResults', (d) => {
    if (typeof d.matches?.[0] === 'string') handlers.onTranscript(d.matches[0])
  })
  listeningHandle = await plugin.addListener('listeningState', (d) => {
    if (d.status === 'stopped') end()
  })

  try {
    await plugin.start({
      language: navigator.language || 'en-US',
      maxResults: 1,
      partialResults: true,
      popup: false,
    })
  } catch (err) {
    end()
    throw err
  }

  // Gotcha: once start() has resolved, the Android plugin has NO error
  // channel — a speech-timeout or recognizer-internal error silently stops
  // the recognizer without ever firing a `listeningState: 'stopped'` event,
  // which would strand the composer's mic button in "listening" forever.
  // Poll isListening() as a watchdog and end() the session ourselves the
  // moment it disagrees with our own state.
  watchdog = setInterval(() => {
    plugin
      .isListening()
      .then((s) => {
        if (!s.listening) end()
      })
      .catch(() => {
        // best-effort poll — a transient failure here shouldn't itself end
        // the session; the next tick (or a real listeningState event) will.
      })
  }, 2000)

  return {
    stop() {
      plugin.stop().catch(() => {})
      end()
    },
  }
}

function startWebDictation(handlers: DictationHandlers): DictationSession {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Ctor) throw new Error('Dictation is not supported on this device')

  const rec = new Ctor()
  rec.continuous = true
  rec.interimResults = true
  rec.lang = navigator.language || 'en-US'

  let ended = false
  let stashedMessage = ''

  const end = (error?: string) => {
    if (ended) return
    ended = true
    handlers.onEnd(error)
  }

  rec.onresult = (e) => handlers.onTranscript(transcriptFromResults(e.results))
  rec.onerror = (e) => {
    stashedMessage = speechErrorMessage(e.error)
  }
  rec.onend = () => end(stashedMessage || undefined)

  try {
    rec.start()
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }

  return {
    stop() {
      try {
        rec.stop()
      } catch {
        // best-effort — onend still fires (or already has) either way
      }
    },
  }
}

/** Start a dictation session, preferring the native plugin when it's both
 *  registered AND reports itself runtime-available, falling back to the Web
 *  Speech API otherwise. Rejects if neither backend is usable. */
export async function startDictation(handlers: DictationHandlers): Promise<DictationSession> {
  if (nativeDictationAvailable()) {
    const plugin = nativePlugin()
    const status = plugin
      ? await plugin.available().catch(() => ({ available: false }))
      : {
          available: false,
        }
    if (status.available) return startNativeDictation(handlers)
  }
  if (webDictationAvailable()) return startWebDictation(handlers)
  throw new Error('Dictation is not supported on this device')
}
