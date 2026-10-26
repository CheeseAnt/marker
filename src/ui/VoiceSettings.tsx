import { useEffect, useId, useState } from 'react'
import type { Settings } from '../settings/schema'
import { SPEECH_MODELS, type SpeechModelId } from '../speech/models'
import { deleteModel, isModelDownloaded, onDevice, type LoadProgress } from '../speech/onDevice'
import { DEFAULT_SHORTCUTS } from '../settings/defaults'
import { parseShortcut, shortcutConflict, shortcutFromEvent } from '../speech/shortcut'
import { webSpeechAvailable } from '../speech/webSpeech'
import { useVoice } from '../speech/voice'

type Voice = Settings['voice']
type Shortcuts = Settings['shortcuts']

const MODES: { id: Voice['mode']; label: string; note: string }[] = [
  { id: 'on-device', label: 'On this device', note: 'Private and free. Downloads a speech model once.' },
  { id: 'remote', label: 'Through Azure', note: 'Uses a transcription deployment on your Azure resource.' },
  { id: 'browser', label: "The browser's own", note: 'Chrome and Edge only. Audio goes to the browser maker to be transcribed.' },
  { id: 'off', label: 'Off', note: 'No microphone button or shortcut.' },
]

const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator

function ModelRow({ id, checked, onChoose }: { id: SpeechModelId; checked: boolean; onChoose: () => void }) {
  const model = SPEECH_MODELS.find((m) => m.id === id)!
  const [state, setState] = useState<'unknown' | 'downloaded' | 'missing' | 'downloading'>('unknown')
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void isModelDownloaded(model.repo).then((d) => live && setState(d ? 'downloaded' : 'missing'))
    return () => {
      live = false
    }
  }, [model.repo])

  const download = async () => {
    setState('downloading')
    setError(null)
    try {
      await onDevice.load(model.repo, setProgress)
      setState('downloaded')
    } catch (e) {
      setState('missing')
      setError((e as Error).message)
    }
    void useVoice.getState().refreshModel()
  }

  return (
    <div className="model-row">
      <label className="choice-check">
        <input type="radio" name="speech-model" checked={checked} onChange={onChoose} />
        <span>
          <span className="model-name">{model.label}</span>
          <span className="model-note">
            {model.note} {hasWebGPU ? model.size.webgpu : model.size.wasm} MB.
          </span>
        </span>
      </label>
      <span className="model-actions">
        {state === 'downloaded' && (
          <>
            <span className="model-ready">Downloaded</span>
            <button
              type="button"
              className="quiet"
              onClick={async () => {
                await deleteModel(model.repo)
                setState('missing')
                void useVoice.getState().refreshModel()
              }}
            >
              Delete
            </button>
          </>
        )}
        {state === 'missing' && (
          <button type="button" onClick={download}>
            Download now
          </button>
        )}
        {state === 'downloading' && (
          <span className="model-progress" role="status">
            {progress?.total ? `${Math.floor((progress.loaded / progress.total) * 100)}%` : 'Starting…'}
          </span>
        )}
      </span>
      {error && <p className="field-hint error">{error}</p>}
    </div>
  )
}

function ShortcutField({ label, value, fallback, onChange }: { label: string; value: string; fallback: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false)
  const id = useId()
  const conflict = shortcutConflict(value)
  const valid = Boolean(parseShortcut(value))
  return (
    <div className="field shortcut-field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row">
        <button
          id={id}
          type="button"
          className={`shortcut-capture ${recording ? 'recording' : ''}`}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            if (!recording) return
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') return setRecording(false)
            const next = shortcutFromEvent(e.nativeEvent)
            if (next) {
              onChange(next)
              setRecording(false)
            }
          }}
        >
          {recording ? 'Press the keys…' : value}
        </button>
        {value !== fallback && (
          <button type="button" className="quiet" onClick={() => onChange(fallback)}>
            Use {fallback}
          </button>
        )}
      </div>
      {!valid && <p className="field-hint error">That isn't a key combination BoardBot understands.</p>}
      {conflict && <p className="field-hint error">{value} is already used for {conflict}, so it may not reach BoardBot.</p>}
    </div>
  )
}

interface Props {
  voice: Voice
  shortcuts: Shortcuts
  transcriptionDeployment: string
  onVoice: (v: Voice) => void
  onShortcuts: (s: Shortcuts) => void
  onTranscriptionDeployment: (d: string) => void
}

/** Voice and shortcut settings, edited as a draft like the rest of the dialog. */
export function VoiceSettings({ voice, shortcuts, transcriptionDeployment, onVoice, onShortcuts, onTranscriptionDeployment }: Props) {
  const deploymentId = useId()
  return (
    <>
      <section className="settings-section" aria-labelledby="voice-heading">
        <h3 id="voice-heading">Voice</h3>
        <fieldset className="choice-list">
          <legend>Turn speech into text</legend>
          {MODES.map((m) => (
            <label key={m.id} className="choice-check mode-choice">
              <input
                type="radio"
                name="voice-mode"
                checked={voice.mode === m.id}
                disabled={m.id === 'browser' && !webSpeechAvailable()}
                onChange={() => onVoice({ ...voice, mode: m.id })}
              />
              <span>
                <span className="model-name">{m.label}</span>
                <span className="model-note">{m.note}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {voice.mode === 'on-device' && (
          <fieldset className="choice-list">
            <legend>Speech model</legend>
            {SPEECH_MODELS.map((m) => (
              <ModelRow key={m.id} id={m.id} checked={voice.onDeviceModel === m.id} onChoose={() => onVoice({ ...voice, onDeviceModel: m.id })} />
            ))}
          </fieldset>
        )}

        {voice.mode === 'remote' && (
          <div className="field">
            <label htmlFor={deploymentId}>Transcription deployment</label>
            <input
              id={deploymentId}
              autoComplete="off"
              spellCheck={false}
              placeholder="gpt-4o-transcribe"
              value={transcriptionDeployment}
              onChange={(e) => onTranscriptionDeployment(e.target.value)}
            />
            <p className="field-hint">The name of a gpt-4o-transcribe, gpt-4o-mini-transcribe or whisper deployment on the same resource and key.</p>
          </div>
        )}

        {voice.mode !== 'off' && (
          <label className="choice-check">
            <input type="checkbox" checked={voice.autoSend} onChange={(e) => onVoice({ ...voice, autoSend: e.target.checked })} />
            Send spoken requests straight away, instead of leaving them in the prompt bar to check
          </label>
        )}
      </section>

      <section className="settings-section" aria-labelledby="shortcuts-heading">
        <h3 id="shortcuts-heading">Shortcuts</h3>
        <ShortcutField label="Jump to the prompt bar" value={shortcuts.focusPrompt} fallback={DEFAULT_SHORTCUTS.focusPrompt} onChange={(v) => onShortcuts({ ...shortcuts, focusPrompt: v })} />
        <ShortcutField
          label="Hold to talk (tap to start and stop)"
          value={shortcuts.pushToTalk}
          fallback={DEFAULT_SHORTCUTS.pushToTalk}
          onChange={(v) => onShortcuts({ ...shortcuts, pushToTalk: v })}
        />
      </section>
    </>
  )
}
