import { center, DEFAULT_FONT_SIZE, effectiveStyle, measureText, resolveBoxes, type Box } from '../model/geometry'
import { fontPreset } from '../model/fonts'
import { hashString } from '../model/hash'
import { parsePath } from '../model/path'
import type { Board, BoardElement, EdgeElement, Endpoint, Hints, Id, Point, Style } from '../model/types'
import {
  BIND_GAP,
  DEFAULT_FILL,
  DEFAULT_STROKE,
  FILL_STYLE,
  labelId,
  ROUNDNESS,
  STICKY_FILL,
  type ExElement,
} from './exTypes'

/** Stable 31-bit hash so an element keeps the same hand-drawn wobble across compiles. */
export function seedFor(id: string): number {
  return hashString(id) % 2_147_483_647 || 1
}

function hintNum(h: Hints, key: string): number | undefined {
  return typeof h[key] === 'number' ? (h[key] as number) : undefined
}

function base(el: BoardElement, type: string, box: Box, style: Style, groupIds: string[]): ExElement {
  const seed = hintNum(el.hints, 'seed') ?? seedFor(el.id)
  return {
    id: el.id,
    type,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    angle: hintNum(el.hints, 'angle') ?? 0,
    strokeColor: style.stroke ?? DEFAULT_STROKE,
    backgroundColor: style.fill ?? DEFAULT_FILL,
    fillStyle: FILL_STYLE[style.pattern ?? 'solid'],
    strokeWidth: style.width ?? 2,
    strokeStyle: style.line ?? 'solid',
    roughness: style.rough ?? 1,
    opacity: style.opacity ?? 100,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    index: null,
    isDeleted: false,
    groupIds,
    frameId: null,
    boundElements: null,
    updated: 1,
    link: typeof el.hints.link === 'string' ? el.hints.link : null,
    locked: el.hints.locked === true,
  }
}

function fontFamily(style: Style, hints: Hints): number {
  return hintNum(hints, 'fontFamily') ?? fontPreset(style.font).family
}

function textElement(
  id: string,
  text: string,
  at: Point,
  style: Style,
  hints: Hints,
  groupIds: string[],
  container: { id: string; center: Point } | null,
  seedSource: BoardElement,
): ExElement {
  const fontSize = style.fontSize ?? DEFAULT_FONT_SIZE
  const size = measureText(text, fontSize, style.font)
  const pos = container ? { x: container.center.x - size.w / 2, y: container.center.y - size.h / 2 } : at
  const el = base({ ...seedSource, id, hints: container ? {} : hints }, 'text', { ...pos, ...size }, style, groupIds)
  return {
    ...el,
    // Labels take colour and font from their owner but are never filled.
    backgroundColor: DEFAULT_FILL,
    text,
    originalText: text,
    fontSize,
    fontFamily: fontFamily(style, hints),
    textAlign: container ? 'center' : (style.align ?? 'left'),
    verticalAlign: container ? 'middle' : 'top',
    containerId: container?.id ?? null,
    autoResize: true,
    lineHeight: 1.25,
  }
}

function headStyle(hint: Hints[string] | undefined): string {
  return typeof hint === 'string' ? hint : 'arrow'
}

type Outline = 'rect' | 'ellipse' | 'diamond'

/** Point on the outline of `box` in the direction of `toward`, pulled back by `gap`. */
export function boundaryPoint(box: Box, outline: Outline, toward: Point, gap: number): Point {
  const c = center(box)
  let dx = toward.x - c.x
  let dy = toward.y - c.y
  if (dx === 0 && dy === 0) dx = 1
  const len = Math.hypot(dx, dy)
  const rx = box.w / 2
  const ry = box.h / 2
  let t: number
  if (outline === 'ellipse') t = 1 / Math.hypot(dx / rx, dy / ry)
  else if (outline === 'diamond') t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
  else t = Math.min(rx / Math.abs(dx || 1e-9), ry / Math.abs(dy || 1e-9))
  const back = Math.min(gap / len, t)
  dx *= t + back
  dy *= t + back
  return { x: c.x + dx, y: c.y + dy }
}

function outlineOf(el: BoardElement | undefined): Outline {
  if (el?.kind !== 'node') return 'rect'
  return el.shape === 'sticky' ? 'rect' : el.shape
}

export interface Compiled {
  elements: ExElement[]
  /** Resolved boxes of placeable elements and groups, for layout and decompile. */
  boxes: Map<Id, Box>
}

/** Groups containing `id`, innermost first, which is Excalidraw's groupIds order. */
function groupChains(board: Board): Map<Id, string[]> {
  const parent = new Map<Id, Id>()
  for (const el of board.elements) if (el.kind === 'group') for (const m of el.members) parent.set(m, el.id)
  const chains = new Map<Id, string[]>()
  for (const el of board.elements) {
    const chain: string[] = []
    const seen = new Set<Id>()
    for (let g = parent.get(el.id); g && !seen.has(g); g = parent.get(g)) {
      seen.add(g)
      chain.push(g)
    }
    chains.set(el.id, chain)
  }
  return chains
}

/** Compiles a board to Excalidraw elements in z-order. Deterministic for a given board. */
export function compileBoard(board: Board): Compiled {
  const boxes = resolveBoxes(board)
  const chains = groupChains(board)
  const byId = new Map(board.elements.map((e) => [e.id, e]))
  const out: ExElement[] = []
  const bound = new Map<Id, { id: string; type: 'arrow' | 'text' }[]>()
  const bind = (owner: Id, ref: { id: string; type: 'arrow' | 'text' }) => {
    const list = bound.get(owner) ?? []
    list.push(ref)
    bound.set(owner, list)
  }

  const endpointPoint = (end: Endpoint, toward: Point): { point: Point; bindTo?: Id } => {
    if ('point' in end) return { point: end.point }
    const box = boxes.get(end.id)
    if (!box) return { point: toward }
    return { point: boundaryPoint(box, outlineOf(byId.get(end.id)), toward, BIND_GAP), bindTo: end.id }
  }

  const compileEdge = (el: EdgeElement, style: Style, groupIds: string[]): ExElement[] => {
    const rough = (end: Endpoint) => ('point' in end ? end.point : center(boxes.get(end.id) ?? { x: 0, y: 0, w: 0, h: 0 }))
    const via = el.via ?? []
    const start = endpointPoint(el.from, via[0] ?? rough(el.to))
    const end = endpointPoint(el.to, via.at(-1) ?? rough(el.from))
    const absolute = [start.point, ...via, end.point]
    const xs = absolute.map((p) => p.x)
    const ys = absolute.map((p) => p.y)
    const box = { x: start.point.x, y: start.point.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    const arrow: ExElement = {
      ...base(el, 'arrow', box, style, groupIds),
      roundness: el.hints.roundness === 'sharp' ? null : { type: ROUNDNESS.proportional },
      points: absolute.map((p) => [p.x - start.point.x, p.y - start.point.y] as const),
      lastCommittedPoint: null,
      startBinding: start.bindTo ? { elementId: start.bindTo, focus: 0, gap: BIND_GAP } : null,
      endBinding: end.bindTo ? { elementId: end.bindTo, focus: 0, gap: BIND_GAP } : null,
      startArrowhead: el.head === '<-' || el.head === '<->' ? headStyle(el.hints.startHead) : null,
      endArrowhead: el.head === '->' || el.head === '<->' ? headStyle(el.hints.endHead) : null,
      elbowed: false,
    }
    if (start.bindTo) bind(start.bindTo, { id: el.id, type: 'arrow' })
    if (end.bindTo) bind(end.bindTo, { id: el.id, type: 'arrow' })
    const result = [arrow]
    if (el.label) {
      const n = absolute.length
      const [a, b] = n % 2 ? [absolute[(n - 1) / 2], absolute[(n - 1) / 2]] : [absolute[n / 2 - 1], absolute[n / 2]]
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      result.push(textElement(labelId(el.id), el.label, midpoint, style, el.hints, groupIds, { id: el.id, center: midpoint }, el))
      bind(el.id, { id: labelId(el.id), type: 'text' })
    }
    return result
  }

  for (const el of board.elements) {
    const style = effectiveStyle(board, el)
    const groupIds = chains.get(el.id) ?? []
    const box = boxes.get(el.id)
    switch (el.kind) {
      case 'node': {
        if (!box) break
        const sticky = el.shape === 'sticky'
        const type = sticky ? 'rectangle' : el.shape === 'rect' ? 'rectangle' : el.shape
        const shapeStyle = sticky ? { fill: STICKY_FILL, ...style } : style
        const roundness =
          el.hints.roundness === 'sharp' || el.shape === 'ellipse'
            ? null
            : { type: el.shape === 'diamond' ? ROUNDNESS.proportional : ROUNDNESS.adaptive }
        out.push({ ...base(el, type, box, shapeStyle, groupIds), roundness })
        if (el.label) {
          out.push(textElement(labelId(el.id), el.label, box, style, el.hints, groupIds, { id: el.id, center: center(box) }, el))
          bind(el.id, { id: labelId(el.id), type: 'text' })
        }
        break
      }
      case 'edge':
        out.push(...compileEdge(el, style, groupIds))
        break
      case 'text':
        if (box) out.push(textElement(el.id, el.text, box, style, el.hints, groupIds, null, el))
        break
      case 'image':
        if (box) out.push({ ...base(el, 'image', box, style, groupIds), fileId: el.asset, status: 'saved', scale: [1, 1], crop: null })
        break
      case 'draw': {
        const pts = parsePath(el.path).points
        const xs = pts.map((p) => p.x)
        const ys = pts.map((p) => p.y)
        const drawBox = { x: el.at.x, y: el.at.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
        out.push({
          ...base(el, 'freedraw', drawBox, style, groupIds),
          points: pts.map((p) => [p.x, p.y] as const),
          pressures: [],
          simulatePressure: true,
          lastCommittedPoint: null,
        })
        break
      }
      case 'group':
        break
    }
  }

  for (const el of out) {
    const refs = bound.get(el.id)
    if (refs) el.boundElements = refs
  }
  return { elements: out, boxes }
}
