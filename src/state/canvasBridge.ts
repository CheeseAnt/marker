import type { Id } from '../model/types'

/** What the rest of the app may ask of the canvas. BoardCanvas registers the implementation. */
export interface CanvasBridge {
  /** Board ids of the current selection (labels count as their owner). */
  selection: () => Id[]
  /** Briefly marks these board elements once the next render has put them on the canvas. */
  highlightAfterRender: (ids: Id[]) => void
  /** The scene point at the middle of the visible canvas. */
  viewportCenter: () => { x: number; y: number }
}

let bridge: CanvasBridge | null = null

export function registerCanvas(b: CanvasBridge | null) {
  bridge = b
}

export function canvasSelection(): Id[] {
  return bridge?.selection() ?? []
}

export function highlightAfterRender(ids: Id[]) {
  bridge?.highlightAfterRender(ids)
}

export function viewportCenter(): { x: number; y: number } {
  return bridge?.viewportCenter() ?? { x: 0, y: 0 }
}
