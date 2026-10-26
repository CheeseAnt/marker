import { BoardTextPanel } from './BoardTextPanel'
import { DRAWER_LABELS, type DrawerView } from './drawerViews'
import { HistoryPanel } from './HistoryPanel'
import { TemplatesPanel } from './TemplatesPanel'
import { UsagePanel } from './UsagePanel'

/** Side drawer next to the canvas, showing one view at a time. */
export function Drawer({ view, onSaveSelection, onOpenSettings }: { view: DrawerView; onSaveSelection: () => void; onOpenSettings: () => void }) {
  return (
    <aside className="drawer" aria-label={DRAWER_LABELS[view]}>
      {view === 'text' && <BoardTextPanel />}
      {view === 'history' && <HistoryPanel />}
      {view === 'templates' && <TemplatesPanel onSaveSelection={onSaveSelection} />}
      {view === 'usage' && <UsagePanel onOpenSettings={onOpenSettings} />}
    </aside>
  )
}
