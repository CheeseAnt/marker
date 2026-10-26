import { BoardTextPanel } from './BoardTextPanel'
import { DRAWER_LABELS, type DrawerView } from './drawerViews'
import { HistoryPanel } from './HistoryPanel'

/** Side drawer next to the canvas, showing one view at a time. */
export function Drawer({ view }: { view: DrawerView }) {
  return (
    <aside className="drawer" aria-label={DRAWER_LABELS[view]}>
      {view === 'text' ? <BoardTextPanel /> : <HistoryPanel />}
    </aside>
  )
}
