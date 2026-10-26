import { isProviderReady, PROVIDER_LABELS } from '../ai/providers'
import { hasApiKey, useSettings } from '../settings/store'
import { useBoard } from '../state/board'
import { DRAWER_LABELS, type DrawerView } from './drawerViews'
import { JobStatus, SessionUsage } from './JobStatus'

const VOICE_LABELS = {
  'moonshine-base': 'Moonshine base',
  'moonshine-tiny': 'Moonshine tiny',
  'whisper-base.en': 'Whisper base',
  'whisper-small.en': 'Whisper small',
} as const

interface Props {
  notice: string | null
  onDismissNotice: () => void
  drawer: DrawerView | null
  onToggleDrawer: (view: DrawerView) => void
  onOpenSettings: () => void
}

export function StatusBar({ notice, onDismissNotice, drawer, onToggleDrawer, onOpenSettings }: Props) {
  const settings = useSettings((s) => s.settings)
  const secrets = useSettings((s) => s.secrets)
  const count = useBoard((s) => s.board.elements.filter((e) => e.kind !== 'group').length)
  const provider = settings.activeProvider
  const config = settings.providers[provider]
  const ready = isProviderReady(settings, secrets)
  const configured = ready || Boolean(config.endpoint.trim())
  const voice = settings.voice

  return (
    <footer className="status">
      <span>{voice.mode === 'off' ? 'Voice off' : voice.mode === 'on-device' ? `Voice: ${VOICE_LABELS[voice.onDeviceModel]}` : `Voice: ${voice.mode}`}</span>
      <button type="button" className={`status-link ${ready ? '' : 'attention'}`} onClick={onOpenSettings} title="Open settings">
        {PROVIDER_LABELS[provider]}
        {ready ? `: ${config.deployment || 'connected'}` : !configured ? ' not set up' : !hasApiKey(secrets, provider) ? ' needs an API key' : ' needs a deployment'}
      </button>
      {notice ? (
        <span className="status-notice" role="alert">
          <span title={notice}>{notice}</span>
          <button type="button" onClick={onDismissNotice}>
            Dismiss
          </button>
        </span>
      ) : null}
      <JobStatus />
      <span className="spacer" />
      <SessionUsage />
      <span>{count === 1 ? '1 element' : `${count} elements`}</span>
      <button type="button" className="status-link" onClick={onOpenSettings}>
        Settings
      </button>
      <div className="drawer-toggles" role="group" aria-label="Side panel">
        {(Object.keys(DRAWER_LABELS) as DrawerView[]).map((view) => (
          <button key={view} type="button" aria-pressed={drawer === view} onClick={() => onToggleDrawer(view)}>
            {DRAWER_LABELS[view]}
          </button>
        ))}
      </div>
    </footer>
  )
}
