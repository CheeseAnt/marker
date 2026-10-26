import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs/lib/elk-api'
import { intrinsicSize, resolveBoxes, unionBoxes, type Box } from '../model/geometry'
import type { Op } from '../model/ops'
import type { Board, BoardElement, Id } from '../model/types'

const elk = new ELK()
const ANCHOR_GAP = 80
const CLEARANCE = 30
const MAX_NUDGES = 60

function isUnplaced(el: BoardElement): boolean {
  return (el.kind === 'node' || el.kind === 'text') && !el.at
}

function overlaps(a: Box, b: Box, pad = CLEARANCE): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
}

/** Connected components of `ids`, following edges between them. */
function components(board: Board, ids: Set<Id>): Id[][] {
  const adj = new Map<Id, Set<Id>>([...ids].map((id) => [id, new Set<Id>()]))
  for (const el of board.elements) {
    if (el.kind !== 'edge' || !('id' in el.from) || !('id' in el.to)) continue
    if (ids.has(el.from.id) && ids.has(el.to.id)) {
      adj.get(el.from.id)!.add(el.to.id)
      adj.get(el.to.id)!.add(el.from.id)
    }
  }
  const seen = new Set<Id>()
  const out: Id[][] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const comp: Id[] = []
    const stack = [id]
    seen.add(id)
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (const n of adj.get(cur)!) {
        if (seen.has(n)) continue
        seen.add(n)
        stack.push(n)
      }
    }
    out.push(comp)
  }
  return out
}

/** Lays out one component with ELK's layered algorithm; positions are relative to the block. */
async function layoutBlock(board: Board, ids: Id[]): Promise<{ boxes: Map<Id, Box>; w: number; h: number }> {
  const members = new Set(ids)
  const byId = new Map(board.elements.map((e) => [e.id, e]))
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    },
    children: ids.map((id) => {
      const size = intrinsicSize(board, byId.get(id)!)!
      return { id, width: size.w, height: size.h }
    }),
    edges: board.elements
      .filter((e) => e.kind === 'edge' && 'id' in e.from && 'id' in e.to && members.has(e.from.id) && members.has(e.to.id))
      .map((e) => {
        const edge = e as Extract<BoardElement, { kind: 'edge' }>
        return { id: edge.id, sources: [(edge.from as { id: Id }).id], targets: [(edge.to as { id: Id }).id] }
      }),
  }
  const result = await elk.layout(graph)
  const raw = (result.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 }))
  // Drop ELK's outer padding so the block starts at (0,0).
  const bounds = unionBoxes(raw) ?? { x: 0, y: 0, w: 0, h: 0 }
  const boxes = new Map<Id, Box>(raw.map((b) => [b.id, { x: b.x - bounds.x, y: b.y - bounds.y, w: b.w, h: b.h }]))
  return { boxes, w: bounds.w, h: bounds.h }
}

/** The placed element a component is most connected to, if any. */
function anchorFor(board: Board, comp: Set<Id>, placed: Map<Id, Box>): Box | undefined {
  const counts = new Map<Id, number>()
  for (const el of board.elements) {
    if (el.kind !== 'edge' || !('id' in el.from) || !('id' in el.to)) continue
    const [a, b] = [el.from.id, el.to.id]
    if (comp.has(a) && placed.has(b) && !comp.has(b)) counts.set(b, (counts.get(b) ?? 0) + 1)
    if (comp.has(b) && placed.has(a) && !comp.has(a)) counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  const best = [...counts].sort((x, y) => y[1] - x[1])[0]
  return best && placed.get(best[0])
}

/**
 * Gives every node or text without a placement an absolute position: each connected group
 * of new elements is laid out together, then put below whatever it connects to (or right of
 * the board), nudged until it overlaps nothing. Returns ops so the result is saved and undoable.
 */
export async function placeUnplaced(board: Board): Promise<Op[]> {
  const unplaced = new Set(board.elements.filter(isUnplaced).map((e) => e.id))
  if (unplaced.size === 0) return []
  const resolved = resolveBoxes(board)
  // Boxes of everything except the unplaced elements (and anything anchored to them).
  const placed = new Map<Id, Box>()
  const dependsOnUnplaced = (el: BoardElement): boolean =>
    (el.kind === 'node' || el.kind === 'text' || el.kind === 'image') && el.at?.kind === 'rel' && unplaced.has(el.at.of)
  for (const el of board.elements) {
    const box = resolved.get(el.id)
    if (box && el.kind !== 'group' && !unplaced.has(el.id) && !dependsOnUnplaced(el)) placed.set(el.id, box)
  }

  const ops: Op[] = []
  for (const comp of components(board, unplaced)) {
    const block = await layoutBlock(board, comp)
    const anchor = anchorFor(board, new Set(comp), placed)
    const content = unionBoxes([...placed.values()])
    let origin = anchor
      ? { x: anchor.x + anchor.w / 2 - block.w / 2, y: anchor.y + anchor.h + ANCHOR_GAP }
      : content
        ? { x: content.x + content.w + ANCHOR_GAP * 1.5, y: content.y }
        : { x: 0, y: 0 }
    const collides = (o: { x: number; y: number }) =>
      [...block.boxes.values()].some((b) => [...placed.values()].some((p) => overlaps({ ...b, x: b.x + o.x, y: b.y + o.y }, p)))
    for (let i = 0; i < MAX_NUDGES && collides(origin); i++) {
      origin = anchor ? { x: origin.x + 40, y: origin.y } : { x: origin.x, y: origin.y + 40 }
    }
    for (const id of comp) {
      const b = block.boxes.get(id)!
      const box = { ...b, x: Math.round(b.x + origin.x), y: Math.round(b.y + origin.y) }
      placed.set(id, box)
      ops.push({ op: 'update', id, set: { at: { kind: 'at', x: box.x, y: box.y } } })
    }
  }
  return ops
}
