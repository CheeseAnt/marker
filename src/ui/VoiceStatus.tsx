import { useEffect, useState } from 'react'
import { useSettings } from '../settings/store'
import { speechModel } from '../speech/models'
import { useVoice } from '../speech/voice'

function seconds(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The voice engine's state: what it is, whether its model is ready, and recording progress. */
export function VoiceStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const voice = useSettings((s) => s.settings.voice)
  const transcription = useSettings((s) => s.settings.providers['azure-foundry'].transcriptionDeployment)
  const status = useVoice((s) => s.status)
  const startedAt = useVoice((s) => s.startedAt)
  const model = useVoice((s) => s.model)
  const [, tick] = useState(0)

  useEffect(() => {
    void useVoice.getState().refreshModel()
  }, [voice.mode, voice.onDeviceModel])

  useEffect(() => {
    if (status !== 'recording') return
    const timer = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [status])

  if (status === 'recording') {
    return (
      <span className="voice-status recording" role="status">
        Recording {seconds(startedAt)}
      </span>
    )
  }
  if (status === 'transcribing') return <span role="status">Turning speech into text…</span>

  let text: string
  if (voice.mode === 'off') text = 'Voice off'
  else if (voice.mode === 'browser') text = 'Voice: browser'
  else if (voice.mode === 'remote') text = `Voice: ${transcription || 'remote, not set up'}`
  else {
    const label = speechModel(voice.onDeviceModel).label
    const p = model.progress
    text =
      model.state === 'downloading'
        ? `Voice: ${label}, downloading${p?.total ? ` ${Math.floor((p.loaded / p.total) * 100)}%` : '…'}`
        : model.state === 'not-downloaded'
          ? `Voice: ${label}, downloads on first use`
          : model.state === 'error'
            ? `Voice: ${label} couldn't load`
            : `Voice: ${label}`
  }
  return (
    <button type="button" className={`status-link ${model.state === 'error' ? 'attention' : ''}`} onClick={onOpenSettings} title="Voice settings">
      {text}
    </button>
  )
}
