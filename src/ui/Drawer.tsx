import { BoardTextPanel } from './BoardTextPanel'
import { DRAWER_LABELS, type DrawerView } from './drawerViews'
import { HistoryPanel } from './HistoryPanel'
import { TemplatesPanel } from './TemplatesPanel'

/** Side drawer next to the canvas, showing one view at a time. */
export function Drawer({ view, onSaveSelection }: { view: DrawerView; onSaveSelection: () => void }) {
  return (
    <aside className="drawer" aria-label={DRAWER_LABELS[view]}>
      {view === 'text' ? <BoardTextPanel /> : view === 'history' ? <HistoryPanel /> : <TemplatesPanel onSaveSelection={onSaveSelection} />}
    </aside>
  )
}
