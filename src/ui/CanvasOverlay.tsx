import type { ReactNode } from 'react'
import type { Box } from '../model/geometry'
import { useBoard } from '../state/board'
import { updateCopies } from '../templates/actions'
import { outdatedCopies, useLibrary } from '../templates/library'
import { toScreen, type View } from './canvasView'

/** A dragged element and one that will move with it because it's placed relative to it. */
export interface FollowLink {
  anchor: Box
  follower: Box
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** Where a line from the middle of `b` towards `toward` leaves the box, so links run edge to edge. */
function edgePoint(b: Box, toward: { x: number; y: number }) {
  const c = center(b)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (!dx && !dy) return c
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  return { x: c.x + dx * Math.min(t, 1), y: c.y + dy * Math.min(t, 1) }
}

/**
 * Things drawn over the canvas in scene positions, kept in place as the board scrolls and
 * zooms. While something is dragged, dashed links show what will follow it when it's dropped.
 */
export function CanvasOverlay({ view, links, children }: { view: View; links: FollowLink[]; children?: ReactNode }) {
  return (
    <div className="canvas-overlay">
      <UpdateBadges view={view} />
      {links.length > 0 && (
        <svg className="follow-links" aria-hidden="true">
          {links.map((l, i) => {
            const anchor = toScreen(l.anchor, view)
            const follower = toScreen(l.follower, view)
            const a = edgePoint(anchor, center(follower))
            const b = edgePoint(follower, center(anchor))
            return (
              <g key={i} className="follow-link">
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <rect x={follower.x - 6} y={follower.y - 6} width={follower.w + 12} height={follower.h + 12} rx={8} />
              </g>
            )
          })}
        </svg>
      )}
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
