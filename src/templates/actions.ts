import type { Id } from '../model/types'
import { useBoard } from '../state/board'
import { highlightAfterRender } from '../state/canvasBridge'
import { useToast } from '../state/toast'
import { updateCopiesOps, type TemplateVersion } from './operations'

export function list(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

/** Moves copies of a template (all of them, or those in `ids`) to version `t`, as one undoable step. */
export function updateCopies(t: TemplateVersion, ids?: Id[]) {
  const { board, apply } = useBoard.getState()
  const report = updateCopiesOps(board, t, ids)
  if (!report.copies.length) return
  apply(report.ops, 'manual', { title: `Updated ${report.copies.length === 1 ? 'a copy' : `${report.copies.length} copies`} of “${t.name}” to version ${t.version}` })
  highlightAfterRender(report.copies)
  if (report.dropped.length) {
    useToast.getState().show({ kind: 'error', text: `Version ${t.version} has no place for: ${list(report.dropped)}. Undo to keep the old version.` })
  }
}
