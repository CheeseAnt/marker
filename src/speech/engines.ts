import { createProvider } from '../ai/providers'
import type { Usage } from '../ai/providers/types'
import type { Secrets, Settings } from '../settings/schema'
import { speechModel } from './models'
import { onDevice, type LoadProgress } from './onDevice'
import { SPEECH_SAMPLE_RATE, startRecording } from './recorder'
import { encodeWav } from './wav'
import { startWebSpeech, webSpeechAvailable } from './webSpeech'

/** One spoken request, from starting to listen to having its text. */
export interface VoiceSession {
  /** Stops listening and returns what was said. */
  end(): Promise<string>
  cancel(): void
  /** Loudness 0 to 1, when the engine can tell. */
  level(): number
}

export interface VoiceEngine {
  label: string
  /** Gets ready ahead of time (downloads a model), reporting progress. */
  prepare?(onProgress: (p: LoadProgress) => void): Promise<void>
  begin(): Promise<VoiceSession>
}

export type EngineChoice = { engine: VoiceEngine } | { unavailable: string }

/** Where usage from remote transcription is reported. */
export type UsageSink = (usage: Usage | undefined, audioSeconds: number) => void

export function createVoiceEngine(settings: Settings, secrets: Secrets, reportUsage: UsageSink): EngineChoice {
  const voice = settings.voice
  switch (voice.mode) {
    case 'off':
      return { unavailable: 'Voice input is off. Turn it on in Settings.' }
    case 'browser':
      if (!webSpeechAvailable()) return { unavailable: 'This browser has no built-in speech recognition. Choose on-device in Settings.' }
      return { engine: { label: 'Browser speech', begin: startWebSpeech } }
    case 'remote': {
      const provider = createProvider(settings, secrets)
      if (!provider.transcribe) {
        return { unavailable: 'Remote voice needs a transcription deployment. Add one in Settings, or use on-device voice.' }
      }
      const transcribe = provider.transcribe
      return {
        engine: {
          label: 'Remote transcription',
          begin: async () => {
            const recording = await startRecording()
            return {
              end: async () => {
                const audio = await recording.stop()
                if (audio.length < SPEECH_SAMPLE_RATE / 4) return ''
                const result = await transcribe(encodeWav(audio, SPEECH_SAMPLE_RATE))
                reportUsage(result.usage, result.audioSeconds)
                return result.text
              },
              cancel: recording.cancel,
              level: recording.level,
            }
          },
        },
      }
    }
    case 'on-device': {
      const model = speechModel(voice.onDeviceModel)
      return {
        engine: {
          label: model.label,
          prepare: async (onProgress) => {
            await onDevice.load(model.repo, onProgress)
          },
          begin: async () => {
            // Loading starts with the recording, so a first use only waits for what's left.
            void onDevice.load(model.repo).catch(() => undefined)
            const recording = await startRecording()
            return {
              end: async () => {
                const audio = await recording.stop()
                if (audio.length < SPEECH_SAMPLE_RATE / 4) return ''
                return (await onDevice.transcribe(model.repo, audio)).text
              },
              cancel: recording.cancel,
              level: recording.level,
            }
          },
        },
      }
    }
  }
}
