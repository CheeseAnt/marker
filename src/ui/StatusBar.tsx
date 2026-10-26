import { hasApiKey, useSettings } from '../settings/store'
import { useBoard } from '../state/board'

const PROVIDER_LABELS = { 'azure-foundry': 'Azure AI Foundry' } as const
const VOICE_LABELS = {
  'moonshine-base': 'Moonshine base',
  'moonshine-tiny': 'Moonshine tiny',
  'whisper-base.en': 'Whisper base',
  'whisper-small.en': 'Whisper small',
} as const

interface Props {
  notice: string | null
  onDismissNotice: () => void
  showText: boolean
  onToggleText: () => void
}

export function StatusBar({ notice, onDismissNotice, showText, onToggleText }: Props) {
  const settings = useSettings((s) => s.settings)
  const secrets = useSettings((s) => s.secrets)
  const count = useBoard((s) => s.board.elements.filter((e) => e.kind !== 'group').length)
  const provider = settings.activeProvider
  const config = settings.providers[provider]
  const configured = Boolean(config.endpoint && config.deployment)
  const ready = configured && hasApiKey(secrets, provider)
  const voice = settings.voice

  return (
    <footer className="status">
      <span>{voice.mode === 'off' ? 'Voice off' : voice.mode === 'on-device' ? `Voice: ${VOICE_LABELS[voice.onDeviceModel]}` : `Voice: ${voice.mode}`}</span>
      <span className={ready ? '' : 'attention'}>
        {PROVIDER_LABELS[provider]}
        {!configured ? ' not set up' : !hasApiKey(secrets, provider) ? ' needs an API key' : `: ${config.deployment}`}
      </span>
      {notice ? (
        <span className="status-notice" role="alert">
          <span title={notice}>{notice}</span>
          <button type="button" onClick={onDismissNotice}>
            Dismiss
          </button>
        </span>
      ) : null}
      <span className="spacer" />
      <span>{count === 1 ? '1 element' : `${count} elements`}</span>
      <button type="button" className="board-text-toggle" aria-pressed={showText} onClick={onToggleText}>
        Board text
      </button>
    </footer>
  )
}
