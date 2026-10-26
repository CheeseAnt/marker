import type { VoiceSession } from './engines'

interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

function constructor(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export function webSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(constructor())
}

/** The browser's own recognition (Chrome and Edge). It listens itself, so no recording is made. */
export async function startWebSpeech(): Promise<VoiceSession> {
  const Recognition = constructor()
  if (!Recognition) throw new Error('This browser has no built-in speech recognition. Choose on-device or remote in Settings.')
  const recognition = new Recognition()
  recognition.lang = 'en-US'
  recognition.continuous = true
  recognition.interimResults = false
  let text = ''
  let failure: string | null = null
  let ended: () => void = () => {}
  const done = new Promise<void>((resolve) => (ended = resolve))
  recognition.onresult = (e) => {
    text = Array.from(e.results)
      .filter((r) => r.isFinal)
      .map((r) => r[0].transcript)
      .join(' ')
  }
  recognition.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') failure = e.error
  }
  recognition.onend = () => ended()
  recognition.start()
  return {
    end: async () => {
      recognition.stop()
      await done
      if (failure) throw new Error(failure === 'not-allowed' ? 'Microphone access is blocked for this site.' : `Speech recognition failed (${failure}).`)
      return text.trim()
    },
    cancel: () => recognition.abort(),
    level: () => 0,
  }
}
