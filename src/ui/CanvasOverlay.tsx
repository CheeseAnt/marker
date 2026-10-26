import type { ReactNode } from 'react'
import { useBoard } from '../state/board'
import { updateCopies } from '../templates/actions'
import { outdatedCopies, useLibrary } from '../templates/library'
import { toScreen, type View } from './canvasView'

/**
 * Things drawn over the canvas in scene positions, kept in place as the board scrolls and
 * zooms.
 */
export function CanvasOverlay({ view, children }: { view: View; children?: ReactNode }) {
  return (
    <div className="canvas-overlay">
      <UpdateBadges view={view} />
      {children}
    </div>
  )
}

/** A small pill on each template copy that has a newer version in the library. */
function UpdateBadges({ view }: { view: View }) {
  const board = useBoard((s) => s.board)
  const boxes = useBoard((s) => s.compiled.boxes)
  const entries = useLibrary((s) => s.entries)
  return outdatedCopies(board, entries).map(({ copy, latest }) => {
    const box = boxes.get(copy.id)
    if (!box) return null
    const screen = toScreen(box, view)
    return (
      <button
        key={copy.id}
        type="button"
        className="update-badge"
        style={{ left: screen.x + screen.w, top: screen.y }}
        title={`A newer version of “${latest.name}” is in your library. Update this copy; undo goes back.`}
        onClick={() => updateCopies(latest, [copy.id])}
      >
        Update to v{latest.version}
      </button>
    )
  })
}
