import { create } from 'zustand'
import { useJobs } from '../jobs/queue'
import { useSettings } from '../settings/store'
import { useToast } from '../state/toast'
import { createVoiceEngine, type VoiceSession } from './engines'
import { speechModel, type SpeechDevice } from './models'
import { isModelDownloaded, type LoadProgress } from './onDevice'

/** Presses shorter than this toggle recording on instead of holding it. */
export const TAP_MS = 300

export type VoiceStatus = 'idle' | 'starting' | 'recording' | 'transcribing'

export interface ModelState {
  state: 'unknown' | 'not-downloaded' | 'downloading' | 'ready' | 'error'
  progress?: LoadProgress
  device?: SpeechDevice
  error?: string
}

interface VoiceState {
  status: VoiceStatus
  /** 'hold' stops on release; 'toggle' (after a tap) stops on the next press. */
  holdMode: 'hold' | 'toggle'
  startedAt: number
  level: number
  model: ModelState
  /** Push-to-talk or mic button pressed. */
  press: () => void
  /** Push-to-talk or mic button released. */
  release: () => void
  stop: () => Promise<void>
  cancel: () => void
  /** Downloads and loads the selected on-device model now. */
  prepareModel: () => Promise<void>
  refreshModel: () => Promise<void>
}

let session: VoiceSession | null = null
let levelTimer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<(text: string) => void>()

/** Called with each finished transcript. Returns an unsubscribe function. */
export function onTranscript(listener: (text: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function engine() {
  const { settings, secrets } = useSettings.getState()
  return createVoiceEngine(settings, secrets, (usage) => {
    if (usage) useJobs.getState().recordUsage(usage)
  })
}

function fail(message: string) {
  useToast.getState().show({ kind: 'error', text: message })
}

export const useVoice = create<VoiceState>((set, get) => {
  const start = async (holdMode: VoiceState['holdMode']) => {
    const choice = engine()
    if ('unavailable' in choice) return fail(choice.unavailable)
    set({ status: 'starting', holdMode, startedAt: Date.now(), level: 0 })
    try {
      session = await choice.engine.begin()
    } catch (e) {
      set({ status: 'idle' })
      return fail((e as Error).message)
    }
    set({ status: 'recording', startedAt: Date.now() })
    levelTimer = setInterval(() => set({ level: session?.level() ?? 0 }), 100)
  }

  return {
    status: 'idle',
    holdMode: 'hold',
    startedAt: 0,
    level: 0,
    model: { state: 'unknown' },
    press: () => {
      const { status, holdMode } = get()
      if ((status === 'recording' || status === 'starting') && holdMode === 'toggle') void get().stop()
      else if (status === 'idle') void start('hold')
    },
    release: () => {
      const { status, holdMode, startedAt } = get()
      if (holdMode !== 'hold' || (status !== 'recording' && status !== 'starting')) return
      if (Date.now() - startedAt < TAP_MS) set({ holdMode: 'toggle' })
      else void get().stop()
    },
    stop: async () => {
      if (get().status === 'starting') {
        // Stop as soon as recording has actually begun.
        set({ holdMode: 'toggle' })
        const wait = setInterval(() => {
          if (get().status !== 'starting') {
            clearInterval(wait)
            if (get().status === 'recording') void get().stop()
          }
        }, 50)
        return
      }
      if (get().status !== 'recording' || !session) return
      clearInterval(levelTimer)
      const current = session
      session = null
      set({ status: 'transcribing', level: 0 })
      try {
        const text = await current.end()
        if (!text) fail('Nothing was heard. Hold the shortcut, or tap it to start and stop, and speak your request.')
        else listeners.forEach((l) => l(text))
      } catch (e) {
        fail(`Couldn't turn that into text: ${(e as Error).message}`)
      } finally {
        set({ status: 'idle' })
        void get().refreshModel()
      }
    },
    cancel: () => {
      clearInterval(levelTimer)
      session?.cancel()
      session = null
      set({ status: 'idle', level: 0 })
    },
    prepareModel: async () => {
      const choice = engine()
      if ('unavailable' in choice || !choice.engine.prepare) return
      set({ model: { state: 'downloading' } })
      try {
        await choice.engine.prepare((progress) => set({ model: { state: 'downloading', progress } }))
        set({ model: { state: 'ready' } })
      } catch (e) {
        set({ model: { state: 'error', error: (e as Error).message } })
      }
    },
    refreshModel: async () => {
      if (get().model.state === 'downloading') return
      const { voice } = useSettings.getState().settings
      if (voice.mode !== 'on-device') return set({ model: { state: 'unknown' } })
      const downloaded = await isModelDownloaded(speechModel(voice.onDeviceModel).repo).catch(() => false)
      set({ model: { state: downloaded ? 'ready' : 'not-downloaded' } })
    },
  }
})
