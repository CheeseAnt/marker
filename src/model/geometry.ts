import { fontPreset, type FontId } from './fonts'
import { parsePath } from './path'
import type { Board, BoardElement, Id, NodeElement, Placement, Size, Style, TextElement } from './types'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const DEFAULT_FONT_SIZE = 20
const LINE_HEIGHT = 1.25
const UNPLACED_GAP = 80

export function effectiveStyle(board: Board, el: { style: Style }): Style {
  return { ...board.defaults, ...el.style }
}

/** Estimated text size. Excalidraw re-measures for real in the browser; this is for layout. */
export function measureText(text: string, fontSize: number, font?: FontId): Size {
  const lines = text.split('\n')
  const longest = Math.max(1, ...lines.map((l) => l.length))
  return { w: Math.ceil(longest * fontSize * fontPreset(font).charWidth), h: Math.ceil(lines.length * fontSize * LINE_HEIGHT) }
}

export function defaultNodeSize(node: NodeElement, fontSize: number, font?: FontId): Size {
  const text = measureText(node.label || ' ', fontSize, font)
  const pad = { rect: [40, 40], sticky: [40, 40], ellipse: [70, 50], diamond: [110, 70] }[node.shape]
  const min = node.shape === 'sticky' ? { w: 160, h: 160 } : { w: 120, h: 60 }
  return {
    w: Math.max(min.w, Math.min(480, text.w + pad[0])),
    h: Math.max(min.h, text.h + pad[1]),
  }
}

export function intrinsicSize(board: Board, el: BoardElement): Size | undefined {
  const style = effectiveStyle(board, el)
  const fontSize = style.fontSize ?? DEFAULT_FONT_SIZE
  switch (el.kind) {
    case 'node':
      return el.size ?? defaultNodeSize(el, fontSize, style.font)
    case 'text':
      return measureText((el as TextElement).text, fontSize, style.font)
    case 'image':
      return el.size
    default:
      return undefined
  }
}

function intrinsicSizeOrDraw(board: Board, el: BoardElement): boolean {
  return el.kind === 'draw' || Boolean(intrinsicSize(board, el))
}

function placementOf(el: BoardElement): Placement | undefined {
  return el.kind === 'node' || el.kind === 'text' || el.kind === 'image' ? el.at : undefined
}

function relativeBox(of: Box, size: Size, p: Extract<Placement, { kind: 'rel' }>): Box {
  const cx = of.x + of.w / 2
  const cy = of.y + of.h / 2
  switch (p.dir) {
    case 'below':
      return { x: cx - size.w / 2, y: of.y + of.h + p.gap, ...wh(size) }
    case 'above':
      return { x: cx - size.w / 2, y: of.y - p.gap - size.h, ...wh(size) }
    case 'right':
      return { x: of.x + of.w + p.gap, y: cy - size.h / 2, ...wh(size) }
    case 'left':
      return { x: of.x - p.gap - size.w, y: cy - size.h / 2, ...wh(size) }
  }
}

function wh(size: Size) {
  return { w: size.w, h: size.h }
}

export function unionBoxes(boxes: Box[]): Box | undefined {
  if (boxes.length === 0) return undefined
  const x1 = Math.min(...boxes.map((b) => b.x))
  const y1 = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.w))
  const y2 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * Resolves the box of every placeable element (nodes, text, images, drawings), then groups.
 * Relative placements follow their anchor; unplaced elements and broken or cyclic anchors
 * fall back to a column right of the placed content, so compile never fails.
 */
export function resolveBoxes(board: Board): Map<Id, Box> {
  const byId = new Map(board.elements.map((e) => [e.id, e]))
  const boxes = new Map<Id, Box>()
  const visiting = new Set<Id>()
  // Elements with no placement, or whose anchor is missing or part of a cycle.
  const unplaced: Id[] = []

  const resolve = (id: Id): Box | undefined => {
    const known = boxes.get(id)
    if (known) return known
    const el = byId.get(id)
    if (!el) return undefined
    if (el.kind === 'draw') {
      const b = parsePath(el.path).bounds
      const box = { x: el.at.x + b.x, y: el.at.y + b.y, w: Math.max(1, b.w), h: Math.max(1, b.h) }
      boxes.set(id, box)
      return box
    }
    const size = intrinsicSize(board, el)
    if (!size) return undefined
    const p = placementOf(el)
    if (!p) {
      unplaced.push(id)
      return undefined
    }
    if (p.kind === 'at') {
      const box = { x: p.x, y: p.y, ...wh(size) }
      boxes.set(id, box)
      return box
    }
    const anchorEl = byId.get(p.of)
    if (!anchorEl || !intrinsicSizeOrDraw(board, anchorEl) || visiting.has(p.of)) {
      unplaced.push(id)
      return undefined
    }
    visiting.add(id)
    const anchor = resolve(p.of)
    visiting.delete(id)
    // An anchor that is itself unplaced gets resolved in the second pass.
    if (!anchor) return undefined
    const box = relativeBox(anchor, size, p)
    boxes.set(id, box)
    return box
  }

  for (const el of board.elements) resolve(el.id)

  // Fallback column for unplaced elements; anything anchored to them resolves in the second pass.
  const placed = unionBoxes([...boxes.values()])
  let cursorY = placed?.y ?? 0
  const columnX = placed ? placed.x + placed.w + UNPLACED_GAP : 0
  for (const id of new Set(unplaced)) {
    if (boxes.has(id)) continue
    const size = intrinsicSize(board, byId.get(id)!)!
    boxes.set(id, { x: columnX, y: cursorY, ...wh(size) })
    cursorY += size.h + UNPLACED_GAP / 2
  }
  for (const el of board.elements) resolve(el.id)

  for (const el of board.elements) {
    if (el.kind === 'group') groupBox(el.id, byId, boxes, new Set())
  }
  return boxes
}

function groupBox(id: Id, byId: Map<Id, BoardElement>, boxes: Map<Id, Box>, seen: Set<Id>): Box | undefined {
  const el = byId.get(id)
  if (!el || el.kind !== 'group') return boxes.get(id)
  if (boxes.has(id)) return boxes.get(id)
  if (seen.has(id)) return undefined
  seen.add(id)
  const box = unionBoxes(
    el.members.map((m) => groupBox(m, byId, boxes, seen)).filter((b): b is Box => Boolean(b)),
  )
  if (box) boxes.set(id, box)
  return box
}

export function center(b: Box) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}
