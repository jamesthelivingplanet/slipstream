/**
 * Unit tests for the dictation bridge (FLO-155). Mirrors the fake-Capacitor
 * approach in haptics.test.ts/widgetSync.test.ts (window.Capacitor is only
 * ever present inside the mobile shell) and the fake-constructible-instance
 * approach in wsApi.test.ts's FakeWebSocket for the Web Speech API path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  nativeDictationAvailable,
  webDictationAvailable,
  dictationAvailable,
  appendTranscript,
  transcriptFromResults,
  speechErrorMessage,
  startDictation,
  type DictationHandlers,
  type SpeechResultList,
} from './speech.js'

// ─── Fake native SpeechRecognition plugin ──────────────────────────────────

type PermStatus = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'

function makeFakeNativePlugin(
  opts: {
    available?: boolean
    checkPerm?: PermStatus
    requestPerm?: PermStatus
    startImpl?: () => Promise<{ matches?: string[] }>
    isListeningImpl?: () => Promise<{ listening: boolean }>
  } = {},
) {
  let partialCb: ((d: { matches: string[] }) => void) | null = null
  let listeningCb: ((d: { status: 'started' | 'stopped' }) => void) | null = null

  const available = vi.fn(async () => ({ available: opts.available ?? true }))
  const checkPermissions = vi.fn(async () => ({
    speechRecognition: opts.checkPerm ?? 'granted',
  }))
  const requestPermissions = vi.fn(async () => ({
    speechRecognition: opts.requestPerm ?? 'granted',
  }))
  const start = vi.fn(opts.startImpl ?? (async () => ({})))
  const stop = vi.fn(async () => {})
  const isListening = vi.fn(opts.isListeningImpl ?? (async () => ({ listening: true })))
  const addListener = vi.fn(async (event: string, cb: (d: unknown) => void) => {
    if (event === 'partialResults') partialCb = cb as (d: { matches: string[] }) => void
    if (event === 'listeningState')
      listeningCb = cb as (d: { status: 'started' | 'stopped' }) => void
    return { remove: vi.fn(async () => {}) }
  })

  return {
    plugin: {
      available,
      checkPermissions,
      requestPermissions,
      start,
      stop,
      isListening,
      addListener,
    },
    firePartial(matches: string[]) {
      partialCb?.({ matches })
    },
    fireListeningStopped() {
      listeningCb?.({ status: 'stopped' })
    },
  }
}

function makeFakeCapacitor(plugin: ReturnType<typeof makeFakeNativePlugin>['plugin'] | undefined) {
  return {
    isPluginAvailable: vi.fn((name: string) => name === 'SpeechRecognition' && !!plugin),
    Plugins: { SpeechRecognition: plugin },
  }
}

// ─── Fake Web Speech API recognizer (mirrors wsApi.test.ts's FakeWebSocket) ─

interface FakeRecognizerInstance {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: SpeechResultList }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  startCalls: number
  stopCalls: number
}

let lastFakeRecognizer: FakeRecognizerInstance | null = null

function makeFakeRecognizerCtor(opts: { startThrows?: Error } = {}) {
  class FakeRecognizer implements FakeRecognizerInstance {
    continuous = false
    interimResults = false
    lang = ''
    onresult: ((e: { results: SpeechResultList }) => void) | null = null
    onerror: ((e: { error: string }) => void) | null = null
    onend: (() => void) | null = null
    startCalls = 0
    stopCalls = 0

    constructor() {
      lastFakeRecognizer = this as unknown as FakeRecognizerInstance
    }

    start() {
      this.startCalls++
      if (opts.startThrows) throw opts.startThrows
    }

    stop() {
      this.stopCalls++
    }
  }
  return FakeRecognizer as unknown as new () => FakeRecognizerInstance
}

function makeResults(entries: Array<{ transcript: string; isFinal: boolean }>): SpeechResultList {
  const arr = entries.map((e) => ({
    0: { transcript: e.transcript, confidence: 1 },
    length: 1,
    isFinal: e.isFinal,
  }))
  const list = { length: arr.length } as SpeechResultList
  arr.forEach((r, i) => {
    ;(list as unknown as Record<number, unknown>)[i] = r
  })
  return list
}

describe('speech', () => {
  beforeEach(() => {
    // @ts-expect-error test-only global stub
    delete globalThis.window
    lastFakeRecognizer = null
  })

  afterEach(() => {
    // @ts-expect-error test-only global stub
    delete globalThis.window
    vi.useRealTimers()
  })

  describe('appendTranscript', () => {
    it('returns base unchanged for empty text', () => {
      expect(appendTranscript('hello', '')).toBe('hello')
    })

    it('returns base unchanged for whitespace-only text', () => {
      expect(appendTranscript('hello', '   ')).toBe('hello')
    })

    it('returns the trimmed text when base is empty', () => {
      expect(appendTranscript('', '  world  ')).toBe('world')
    })

    it('joins without an extra space when base already ends in whitespace', () => {
      expect(appendTranscript('hello ', 'world')).toBe('hello world')
    })

    it('joins with a single space for a normal non-empty base', () => {
      expect(appendTranscript('hello', 'world')).toBe('hello world')
    })
  })

  describe('transcriptFromResults', () => {
    it('returns an empty string for an empty results list', () => {
      expect(transcriptFromResults(makeResults([]))).toBe('')
    })

    it('joins multiple segments including an interim (non-final) entry', () => {
      const results = makeResults([
        { transcript: 'hello', isFinal: true },
        { transcript: 'world', isFinal: false },
      ])
      expect(transcriptFromResults(results)).toBe('hello world')
    })

    it('normalizes away leading spaces on individual transcript segments', () => {
      const results = makeResults([
        { transcript: 'hello', isFinal: true },
        { transcript: ' world', isFinal: true },
      ])
      expect(transcriptFromResults(results)).toBe('hello world')
    })
  })

  describe('speechErrorMessage', () => {
    it('maps not-allowed to a permission message', () => {
      expect(speechErrorMessage('not-allowed')).toBe('Microphone permission denied')
    })

    it('maps service-not-allowed to a permission message', () => {
      expect(speechErrorMessage('service-not-allowed')).toBe('Microphone permission denied')
    })

    it('maps audio-capture to a no-microphone message', () => {
      expect(speechErrorMessage('audio-capture')).toBe('No microphone available')
    })

    it('maps network to a service-unreachable message', () => {
      expect(speechErrorMessage('network')).toBe('Speech recognition service unreachable')
    })

    it('maps no-speech to the benign empty string', () => {
      expect(speechErrorMessage('no-speech')).toBe('')
    })

    it('maps aborted to the benign empty string', () => {
      expect(speechErrorMessage('aborted')).toBe('')
    })

    it('falls back to a generic message for an unknown code', () => {
      expect(speechErrorMessage('some-weird-code')).toBe('Dictation failed (some-weird-code)')
    })
  })

  describe('availability checks', () => {
    it('are all false when window is absent', () => {
      expect(nativeDictationAvailable()).toBe(false)
      expect(webDictationAvailable()).toBe(false)
      expect(dictationAvailable()).toBe(false)
    })

    it('webDictationAvailable is true for a plain browser exposing webkitSpeechRecognition', () => {
      // @ts-expect-error minimal window stub
      globalThis.window = { webkitSpeechRecognition: function () {} }
      expect(webDictationAvailable()).toBe(true)
      expect(nativeDictationAvailable()).toBe(false)
      expect(dictationAvailable()).toBe(true)
    })

    it('nativeDictationAvailable is true inside the mobile shell reporting the plugin available', () => {
      const { plugin } = makeFakeNativePlugin()
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: makeFakeCapacitor(plugin) }
      expect(nativeDictationAvailable()).toBe(true)
      expect(dictationAvailable()).toBe(true)
    })

    it('dictationAvailable is false when neither backend is present', () => {
      // @ts-expect-error minimal window stub
      globalThis.window = {}
      expect(dictationAvailable()).toBe(false)
    })
  })

  describe('startDictation — native path', () => {
    function handlers(): DictationHandlers & {
      onTranscript: ReturnType<typeof vi.fn>
      onEnd: ReturnType<typeof vi.fn>
    } {
      return { onTranscript: vi.fn(), onEnd: vi.fn() }
    }

    it('rejects when permission is denied both on check and request', async () => {
      const { plugin } = makeFakeNativePlugin({ checkPerm: 'denied', requestPerm: 'denied' })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: makeFakeCapacitor(plugin) }
      await expect(startDictation(handlers())).rejects.toThrow('Microphone permission denied')
    })

    it('wires listeners and delivers partial results / a single onEnd on listeningState stopped', async () => {
      const fake = makeFakeNativePlugin({ checkPerm: 'granted' })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: makeFakeCapacitor(fake.plugin) }
      const h = handlers()
      const session = await startDictation(h)

      fake.firePartial(['hello world'])
      expect(h.onTranscript).toHaveBeenCalledWith('hello world')

      fake.fireListeningStopped()
      fake.fireListeningStopped() // fired twice — onEnd must still only fire once
      expect(h.onEnd).toHaveBeenCalledTimes(1)
      expect(h.onEnd).toHaveBeenCalledWith(undefined)

      session.stop()
    })

    it('calling session.stop() invokes plugin.stop() and still only ends once even if a stopped event also fires', async () => {
      const fake = makeFakeNativePlugin({ checkPerm: 'granted' })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: makeFakeCapacitor(fake.plugin) }
      const h = handlers()
      const session = await startDictation(h)

      session.stop()
      fake.fireListeningStopped()

      expect(fake.plugin.stop).toHaveBeenCalledTimes(1)
      expect(h.onEnd).toHaveBeenCalledTimes(1)
    })

    it('the isListening watchdog ends the session when the recognizer died silently', async () => {
      vi.useFakeTimers()
      const fake = makeFakeNativePlugin({
        checkPerm: 'granted',
        isListeningImpl: async () => ({ listening: false }),
      })
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: makeFakeCapacitor(fake.plugin) }
      const h = handlers()
      await startDictation(h)

      expect(h.onEnd).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2000)
      expect(h.onEnd).toHaveBeenCalledTimes(1)
    })
  })

  describe('startDictation — web path', () => {
    function handlers(): DictationHandlers & {
      onTranscript: ReturnType<typeof vi.fn>
      onEnd: ReturnType<typeof vi.fn>
    } {
      return { onTranscript: vi.fn(), onEnd: vi.fn() }
    }

    it('invokes onTranscript with the transcript computed from onresult', async () => {
      const Ctor = makeFakeRecognizerCtor()
      // @ts-expect-error minimal window stub
      globalThis.window = { SpeechRecognition: Ctor }
      const h = handlers()
      await startDictation(h)

      const results = makeResults([{ transcript: 'hi there', isFinal: true }])
      lastFakeRecognizer?.onresult?.({ results })
      expect(h.onTranscript).toHaveBeenCalledWith('hi there')
    })

    it('maps an error code then calls onEnd(message) on onend', async () => {
      const Ctor = makeFakeRecognizerCtor()
      // @ts-expect-error minimal window stub
      globalThis.window = { webkitSpeechRecognition: Ctor }
      const h = handlers()
      await startDictation(h)

      lastFakeRecognizer?.onerror?.({ error: 'network' })
      lastFakeRecognizer?.onend?.()
      expect(h.onEnd).toHaveBeenCalledWith('Speech recognition service unreachable')
    })

    it('a benign error code followed by onend results in onEnd(undefined)', async () => {
      const Ctor = makeFakeRecognizerCtor()
      // @ts-expect-error minimal window stub
      globalThis.window = { SpeechRecognition: Ctor }
      const h = handlers()
      await startDictation(h)

      lastFakeRecognizer?.onerror?.({ error: 'no-speech' })
      lastFakeRecognizer?.onend?.()
      expect(h.onEnd).toHaveBeenCalledWith(undefined)
    })
  })

  describe('startDictation — native plugin present but unavailable at runtime', () => {
    it('falls back to the web backend', async () => {
      const { plugin } = makeFakeNativePlugin({ available: false })
      const Ctor = makeFakeRecognizerCtor()
      // @ts-expect-error minimal window stub
      globalThis.window = { Capacitor: makeFakeCapacitor(plugin), SpeechRecognition: Ctor }
      const h = handlers2()
      await startDictation(h)

      expect(plugin.start).not.toHaveBeenCalled()
      expect(lastFakeRecognizer?.startCalls).toBe(1)
    })

    function handlers2(): DictationHandlers {
      return { onTranscript: vi.fn(), onEnd: vi.fn() }
    }
  })

  describe('startDictation — neither backend available', () => {
    it('rejects with a not-supported message', async () => {
      // @ts-expect-error minimal window stub
      globalThis.window = {}
      await expect(startDictation({ onTranscript: vi.fn(), onEnd: vi.fn() })).rejects.toThrow(
        'Dictation is not supported on this device',
      )
    })
  })
})
