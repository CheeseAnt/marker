import { isProviderReady, PROVIDER_LABELS } from '../ai/providers'
import { hasApiKey, useSettings } from '../settings/store'
import { useBoard } from '../state/board'
import { DRAWER_LABELS, type DrawerView } from './drawerViews'
import { JobStatus, SessionUsage } from './JobStatus'
import { VoiceStatus } from './VoiceStatus'
import { hasUnsavedChanges, saveBoard, useFile } from '../state/file'

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

  return (
    <footer className="status">
      <VoiceStatus onOpenSettings={onOpenSettings} />
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
      <SessionUsage onOpen={() => onToggleDrawer('usage')} />
      <FileStatus />
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

/** The file this board belongs to, and whether it has changes not saved there. Click to save. */
function FileStatus() {
  const name = useFile((s) => s.name)
  const savedHash = useFile((s) => s.savedHash)
  const board = useBoard((s) => s.board)
  const unsaved = hasUnsavedChanges(board, savedHash)
  if (!name && !unsaved) return null
  return (
    <button type="button" className={`status-link file-status ${unsaved ? 'unsaved' : ''}`} onClick={() => void saveBoard()} title="Save (Ctrl+S)">
      {name ? (unsaved ? `${name}, unsaved changes` : name) : 'Not saved to a file'}
    </button>
  )
}
