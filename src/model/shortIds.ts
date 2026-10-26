import type { Op } from './ops'
import type { Board, BoardElement, Id } from './types'

/** Excalidraw's own ids are about 20 random characters; ours are short and readable. */
export function isGeneratedId(id: Id): boolean {
  return id.length >= 16
}

function prefixOf(el: BoardElement): string | undefined {
  switch (el.kind) {
    case 'node':
      return el.shape
    case 'edge':
      return el.head === '--' ? 'line' : 'arrow'
    case 'instance':
      return undefined
    default:
      return el.kind
  }
}

/**
 * Renames for `ids` that are still on the board with generated ids: a node drawn as a
 * rectangle becomes rect1 (or the next free number), an arrow arrow1, and so on.
 */
export function shortIdOps(board: Board, ids: Iterable<Id>): Op[] {
  const used = new Set(board.elements.map((e) => e.id))
  const ops: Op[] = []
  for (const id of ids) {
    const el = board.elements.find((e) => e.id === id)
    const prefix = el && isGeneratedId(id) ? prefixOf(el) : undefined
    if (!prefix) continue
    let n = 1
    while (used.has(`${prefix}${n}`)) n++
    used.add(`${prefix}${n}`)
    ops.push({ op: 'rename', from: id, to: `${prefix}${n}` })
  }
  return ops
}
