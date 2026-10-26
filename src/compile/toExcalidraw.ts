import { center, DEFAULT_FONT_SIZE, effectiveStyle, instanceLayout, measureText, resolveBoxes, type Box } from '../model/geometry'
import { childId } from '../templates/expand'
import { fontPreset } from '../model/fonts'
import { hashString } from '../model/hash'
import { parsePath } from '../model/path'
import type { Board, BoardElement, EdgeElement, Endpoint, Hints, Id, InstanceElement, Point, Style } from '../model/types'
import {
  BIND_GAP,
  cropFromHint,
  CYLINDER_PARTS,
  DEFAULT_FILL,
  DEFAULT_STROKE,
  FILL_STYLE,
  LABEL_SUFFIX,
  labelId,
  partOwner,
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
  return el.shape === 'sticky' || el.shape === 'cylinder' ? 'rect' : el.shape
}

/** Height of a cylinder's top (and bottom) ellipse. */
export function cylinderRim(box: Box): number {
  return Math.round(Math.max(8, Math.min(box.h / 6, box.w / 4)))
}

/** Points of a half ellipse across the width of `box` at height `cy`, left to right. */
function halfEllipse(box: Box, cy: number, ry: number, below: boolean): [number, number][] {
  const steps = 10
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = Math.PI * (1 - i / steps)
    return [box.w / 2 + (box.w / 2) * Math.cos(t), cy + (below ? 1 : -1) * ry * Math.sin(t)]
  })
}

/** The cylinder's outline and rim, grouped with its (invisible) main rectangle. */
function cylinderParts(el: BoardElement, box: Box, style: Style, groupIds: string[]): ExElement[] {
  const ry = cylinderRim(box)
  const top = ry
  const bottom = box.h - ry
  // Down the left side, along the front of the bottom, up the right side, back along the top.
  const outline = [
    ...halfEllipse(box, bottom, ry, true),
    ...halfEllipse(box, top, ry, false).reverse(),
  ]
  outline.push(outline[0])
  const [bodyId, rimId] = CYLINDER_PARTS.map((suffix) => el.id + suffix)
  const body: ExElement = {
    ...base({ ...el, id: bodyId, hints: { ...el.hints, seed: hintNum(el.hints, 'seed') ?? seedFor(bodyId) } }, 'line', box, style, groupIds),
    points: outline.map(([x, y]) => [x, y] as const),
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  }
  const rim: ExElement = {
    ...base({ ...el, id: rimId, hints: { ...el.hints, seed: seedFor(rimId) } }, 'ellipse', { x: box.x, y: box.y, w: box.w, h: ry * 2 }, style, groupIds),
    backgroundColor: DEFAULT_FILL,
  }
  return [body, rim]
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
export function compileBoard(board: Board, depth = 0): Compiled {
  const boxes = resolveBoxes(board, depth)
  const chains = groupChains(board)
  const byId = new Map(board.elements.map((e) => [e.id, e]))

  // Template copies are compiled first, so edges can attach to their ports.
  const copies = new Map<Id, CompiledCopy>()
  for (const el of board.elements) {
    if (el.kind !== 'instance') continue
    const box = boxes.get(el.id)
    if (box) copies.set(el.id, compileCopy(board, el, box, depth))
  }
  const out: ExElement[] = []
  const frames: ExElement[] = []
  const bound = new Map<Id, { id: string; type: 'arrow' | 'text' }[]>()
  const bind = (owner: Id, ref: { id: string; type: 'arrow' | 'text' }) => {
    const list = bound.get(owner) ?? []
    list.push(ref)
    bound.set(owner, list)
  }

  const endpointPoint = (end: Endpoint, toward: Point): { point: Point; bindTo?: Id } => {
    if ('point' in end) return { point: end.point }
    const copy = copies.get(end.id)
    if (copy) {
      // A port binds to the element it names; a copy without a port is met at its outline.
      const port = end.port ? copy.ports.get(end.port) : undefined
      if (port) return { point: boundaryPoint(port.box, port.outline, toward, BIND_GAP), bindTo: port.id }
      return { point: boundaryPoint(copy.box, 'rect', toward, BIND_GAP) }
    }
    const box = boxes.get(end.id)
    if (!box) return { point: toward }
    return { point: boundaryPoint(box, outlineOf(byId.get(end.id)), toward, BIND_GAP), bindTo: end.id }
  }

  const compileEdge = (el: EdgeElement, style: Style, groupIds: string[]): ExElement[] => {
    const rough = (end: Endpoint) => {
      if ('point' in end) return end.point
      const port = end.port ? copies.get(end.id)?.ports.get(end.port) : undefined
      return center(port?.box ?? boxes.get(end.id) ?? { x: 0, y: 0, w: 0, h: 0 })
    }
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
        if (el.shape === 'cylinder') {
          // The node's own element only carries bindings and the label; the parts draw it.
          const group = [el.id, ...groupIds]
          // Excalidraw keeps a label just above its container, so the outline goes underneath both.
          out.push(...cylinderParts(el, box, style, group))
          out.push({ ...base(el, 'rectangle', box, { ...style, stroke: DEFAULT_FILL, fill: DEFAULT_FILL }, group), roundness: null })
          if (el.label) {
            const ry = cylinderRim(box)
            const middle = { x: box.x + box.w / 2, y: box.y + ry + (box.h - ry) / 2 }
            out.push(textElement(labelId(el.id), el.label, box, style, el.hints, group, { id: el.id, center: middle }, el))
            bind(el.id, { id: labelId(el.id), type: 'text' })
          }
          break
        }
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
        if (box) {
          const flip = typeof el.hints.flip === 'string' ? el.hints.flip : ''
          out.push({
            ...base(el, 'image', box, style, groupIds),
            fileId: el.asset,
            status: 'saved',
            scale: [flip.includes('h') ? -1 : 1, flip.includes('v') ? -1 : 1],
            crop: cropFromHint(el.hints.crop),
          })
        }
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
      case 'instance': {
        const copy = copies.get(el.id)
        if (copy) out.push(...copy.elements.map((e) => ({ ...e, groupIds: [...e.groupIds, ...groupIds] })))
        break
      }
      case 'frame':
        if (box) frames.push({ ...base(el, 'frame', box, { ...style, fill: DEFAULT_FILL }, []), name: el.label || null })
        break
      case 'group':
        break
    }
  }

  // Frames go first, under everything, and their members (with labels and parts) point at them.
  const frameOf = new Map<string, string>()
  for (const el of board.elements) if (el.kind === 'frame') for (const m of el.members) frameOf.set(m, el.id)
  if (frameOf.size) {
    for (const e of out) {
      const owner = e.id.endsWith(LABEL_SUFFIX) ? e.id.slice(0, -LABEL_SUFFIX.length) : (partOwner(e.id) ?? e.id.split('/')[0])
      const frame = frameOf.get(owner)
      if (frame) e.frameId = frame
    }
  }
  out.unshift(...frames)

  for (const el of out) {
    const refs = bound.get(el.id)
    if (refs) el.boundElements = [...(el.boundElements ?? []), ...refs]
  }
  return { elements: out, boxes }
}

interface CompiledCopy {
  elements: ExElement[]
  box: Box
  /** Port name to the compiled element it attaches to. */
  ports: Map<string, { id: string; box: Box; outline: Outline }>
}

/**
 * Expands a template copy: compiles its content, then namespaces ids ("web1/box"), moves and
 * scales it into `box`, and groups it as one unit under the instance id. Each copy gets its own
 * hand-drawn wobble because seeds follow the namespaced ids.
 */
function compileCopy(board: Board, el: InstanceElement, box: Box, depth: number): CompiledCopy {
  const layout = instanceLayout(board, el, depth)
  if (!layout) return missingCopy(el, box)
  const inner = compileBoard(layout.content, depth + 1)
  const { bounds, scale } = layout
  const id = (child: string) => childId(el.id, child)
  const tx = (x: number) => box.x + (x - bounds.x) * scale
  const ty = (y: number) => box.y + (y - bounds.y) * scale
  const rebind = (b: ExElement['startBinding']) => (b ? { ...b, elementId: id(b.elementId) } : b)

  const elements = inner.elements.map((e): ExElement => {
    const next: ExElement = {
      ...e,
      id: id(e.id),
      x: tx(e.x),
      y: ty(e.y),
      width: e.width * scale,
      height: e.height * scale,
      seed: seedFor(id(e.id)),
      versionNonce: seedFor(id(e.id)),
      groupIds: [...e.groupIds.map(id), el.id],
      boundElements: e.boundElements?.map((b) => ({ ...b, id: id(b.id) })) ?? null,
    }
    if (e.points) next.points = e.points.map(([x, y]) => [x * scale, y * scale] as const)
    if (e.fontSize) next.fontSize = e.fontSize * scale
    if (e.containerId) next.containerId = id(e.containerId)
    if (e.frameId) next.frameId = id(e.frameId)
    if (e.startBinding !== undefined) next.startBinding = rebind(e.startBinding)
    if (e.endBinding !== undefined) next.endBinding = rebind(e.endBinding)
    return next
  })

  const ports = new Map<string, { id: string; box: Box; outline: Outline }>()
  const def = board.definitions[el.template]
  for (const port of def?.template?.ports ?? []) {
    const target = inner.boxes.get(port.target)
    if (!target) continue
    ports.set(port.name, {
      id: id(port.target),
      box: { x: tx(target.x), y: ty(target.y), w: target.w * scale, h: target.h * scale },
      outline: outlineOf(layout.content.elements.find((c) => c.id === port.target)),
    })
  }
  return { elements, box, ports }
}

/** A dashed placeholder for a copy whose template is missing or nested too deeply. */
function missingCopy(el: InstanceElement, box: Box): CompiledCopy {
  const frame: ExElement = {
    ...base({ ...el, id: childId(el.id, 'missing') }, 'rectangle', box, { line: 'dashed', stroke: '#c8372d' }, [el.id]),
    roundness: null,
  }
  const label = textElement(
    childId(el.id, 'missing~label'),
    `Missing template ${el.template}`,
    box,
    { stroke: '#c8372d', fontSize: 16 },
    {},
    [el.id],
    { id: frame.id, center: center(box) },
    el,
  )
  frame.boundElements = [{ id: label.id, type: 'text' }]
  return { elements: [frame, label], box, ports: new Map() }
}
