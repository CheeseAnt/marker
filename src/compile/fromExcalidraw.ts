import { commit } from '../model/apply'
import { longestIncreasing } from '../model/diffBoards'
import { DEFAULT_FONT_SIZE, effectiveStyle } from '../model/geometry'
import type { Op } from '../model/ops'
import { pointsToPath } from '../model/path'
import {
  idSchema,
  type Board,
  type BoardElement,
  type EdgeElement,
  type Endpoint,
  type Head,
  type Id,
  type Point,
} from '../model/types'
import { DEFAULT_FONT, fontForFamily, fontPreset } from '../model/fonts'
import { FILL_STYLE, LABEL_SUFFIX, type ExElement } from './exTypes'
import { compileBoard, type Compiled } from './toExcalidraw'

const EPS = 0.5

const r2 = (n: number) => {
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? 0 : r
}
const near = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) <= EPS

const STYLE_PROPS = [
  ['strokeColor', 'stroke'],
  ['backgroundColor', 'fill'],
  ['strokeWidth', 'width'],
  ['strokeStyle', 'line'],
  ['roughness', 'rough'],
  ['opacity', 'opacity'],
] as const

const PATTERN_OF = Object.fromEntries(Object.entries(FILL_STYLE).map(([k, v]) => [v, k]))

type Patch = Record<string, unknown>

/** Style and hint changes between what we compiled and what Excalidraw now shows. */
function styleHintDiff(ex: ExElement, c: ExElement, style: Patch, hints: Patch, withShape = true) {
  for (const [prop, key] of STYLE_PROPS) {
    if (ex[prop] !== c[prop]) style[key] = ex[prop]
  }
  if (withShape && ex.fillStyle !== c.fillStyle) style.pattern = PATTERN_OF[ex.fillStyle] ?? 'solid'
  if (!near(ex.angle * 1000, c.angle * 1000)) hints.angle = ex.angle ? r2(ex.angle * 1000) / 1000 : null
  if (ex.seed !== c.seed) hints.seed = ex.seed
  if (ex.link !== c.link) hints.link = ex.link
  if (ex.locked !== c.locked) hints.locked = ex.locked || null
  if (withShape && ex.type !== 'ellipse' && Boolean(ex.roundness) !== Boolean(c.roundness)) {
    hints.roundness = ex.roundness ? null : 'sharp'
  }
}

interface FontRef {
  fontSize?: number
  fontFamily?: number
}

/** The font compile would give a label of `el`, for labels that were added by hand. */
function defaultFont(board: Board, el: BoardElement): FontRef {
  const style = effectiveStyle(board, el)
  const hinted = el.hints.fontFamily
  return {
    fontSize: style.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: typeof hinted === 'number' ? hinted : fontPreset(style.font).family,
  }
}

function fontDiff(ex: ExElement, c: FontRef, style: Patch, hints: Patch) {
  if (ex.fontSize !== c.fontSize) style.fontSize = ex.fontSize
  if (ex.fontFamily !== c.fontFamily) {
    const font = fontForFamily(ex.fontFamily)
    style.font = font ?? DEFAULT_FONT
    hints.fontFamily = font ? null : (ex.fontFamily ?? null)
  }
}

function shapeOf(ex: ExElement, current?: BoardElement) {
  if (ex.type === 'rectangle') return current?.kind === 'node' && current.shape === 'sticky' ? 'sticky' : 'rect'
  return ex.type as 'ellipse' | 'diamond'
}

function headOf(ex: ExElement): { head: Head; hints: Patch } {
  const s = ex.startArrowhead ?? null
  const e = ex.endArrowhead ?? null
  const head: Head = s && e ? '<->' : s ? '<-' : e ? '->' : '--'
  return {
    head,
    hints: {
      startHead: s && s !== 'arrow' ? s : null,
      endHead: e && e !== 'arrow' ? e : null,
    },
  }
}

function absolutePoints(ex: ExElement): Point[] {
  return (ex.points ?? []).map(([x, y]) => ({ x: r2(ex.x + x), y: r2(ex.y + y) }))
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  if ('id' in a && 'id' in b) return a.id === b.id && a.port === b.port
  if ('point' in a && 'point' in b) return near(a.point.x, b.point.x) && near(a.point.y, b.point.y)
  return false
}

function finish(set: Patch, style: Patch, hints: Patch) {
  if (Object.keys(style).length) set.style = style
  // Hints that are null in both places are noise.
  for (const [k, v] of Object.entries(hints)) if (v === null) delete hints[k]
  if (Object.keys(hints).length) set.hints = hints
  return set
}

export interface DiffContext {
  board: Board
  compiled: Compiled
  scene: readonly ExElement[]
}

/**
 * Turns what the user did in Excalidraw into ops against `board`, by comparing the live
 * scene with `compiled` (the scene we last produced from `board`). Unchanged scenes yield [].
 */
export function diffScene({ board, compiled, scene }: DiffContext): Op[] {
  const live = scene.filter((e) => !e.isDeleted)
  const liveById = new Map(live.map((e) => [e.id, e]))
  const compiledById = new Map(compiled.elements.map((e) => [e.id, e]))
  const boardById = new Map(board.elements.map((e) => [e.id, e]))

  // Scene id -> board id, for elements that already exist or are about to be added.
  const takenIds = new Set(board.elements.map((e) => e.id))
  const idFor = new Map<string, Id>()
  for (const id of boardById.keys()) idFor.set(id, id)
  const toBoardId = (exId: string): Id => {
    const known = idFor.get(exId)
    if (known) return known
    let id = idSchema.safeParse(exId).success ? exId : `x${exId.replace(/[^A-Za-z0-9_-]/g, '')}`
    while (takenIds.has(id)) id += '_'
    takenIds.add(id)
    idFor.set(exId, id)
    return id
  }

  // Bound text, keyed by its container's scene id.
  const labelOf = new Map<string, ExElement>()
  for (const e of live) if (e.type === 'text' && e.containerId) labelOf.set(e.containerId, e)

  const endpointOf = (binding: ExElement['startBinding'], fallback: Point | undefined): Endpoint | undefined => {
    const target = binding && liveById.get(binding.elementId)
    if (target && isRendered(target)) return { id: toBoardId(target.id) }
    return fallback && { point: fallback }
  }

  const adds: Op[] = []
  const updates: Op[] = []
  const removes: Op[] = []

  for (const el of board.elements) {
    if (el.kind === 'group') continue
    const ex = liveById.get(el.id)
    const c = compiledById.get(el.id)
    if (!ex) {
      removes.push({ op: 'remove', id: el.id })
      continue
    }
    if (!c) continue
    const set: Patch = {}
    const style: Patch = {}
    const hints: Patch = {}
    switch (el.kind) {
      case 'node': {
        const shape = shapeOf(ex, el)
        if (shape !== el.shape && ['rect', 'ellipse', 'diamond', 'sticky'].includes(shape)) set.shape = shape
        const resized = !near(ex.width, c.width) || !near(ex.height, c.height)
        if (resized) set.size = { w: r2(ex.width), h: r2(ex.height) }
        // Relative placement is centred on the anchor, so a resize must pin the node or it would jump.
        if (!near(ex.x, c.x) || !near(ex.y, c.y) || (resized && el.at?.kind !== 'at')) {
          set.at = { kind: 'at', x: r2(ex.x), y: r2(ex.y) }
        }
        styleHintDiff(ex, c, style, hints)
        const label = labelOf.get(el.id)
        if ((label?.text ?? '') !== el.label) set.label = label?.text ?? ''
        if (label) fontDiff(label, compiledById.get(el.id + LABEL_SUFFIX) ?? defaultFont(board, el), style, hints)
        break
      }
      case 'text':
        if (!near(ex.x, c.x) || !near(ex.y, c.y)) set.at = { kind: 'at', x: r2(ex.x), y: r2(ex.y) }
        if (ex.text !== el.text) set.text = ex.text
        if (ex.textAlign !== c.textAlign) style.align = ex.textAlign
        styleHintDiff(ex, c, style, hints, false)
        fontDiff(ex, c, style, hints)
        break
      case 'image':
        if (!near(ex.x, c.x) || !near(ex.y, c.y)) set.at = { kind: 'at', x: r2(ex.x), y: r2(ex.y) }
        if (!near(ex.width, c.width) || !near(ex.height, c.height)) set.size = { w: r2(ex.width), h: r2(ex.height) }
        if (ex.fileId && ex.fileId !== el.asset) set.asset = ex.fileId
        styleHintDiff(ex, c, style, hints, false)
        break
      case 'draw': {
        const moved = !near(ex.x, c.x) || !near(ex.y, c.y)
        const reshaped =
          ex.points?.length !== c.points?.length ||
          (ex.points ?? []).some(([x, y], i) => !near(x, c.points![i][0]) || !near(y, c.points![i][1]))
        if (moved) set.at = { x: r2(ex.x), y: r2(ex.y) }
        if (reshaped) set.path = pointsToPath((ex.points ?? []).map(([x, y]) => ({ x, y })))
        styleHintDiff(ex, c, style, hints, false)
        break
      }
      case 'edge':
        Object.assign(set, edgeChanges(el, ex, endpointOf))
        styleHintDiff(ex, c, style, hints)
        Object.assign(hints, diffHints(el, headOf(ex).hints))
        // An empty label renders nothing, so it is the same as no label.
        if ((labelOf.get(el.id)?.text || undefined) !== (el.label || undefined)) set.label = labelOf.get(el.id)?.text || null
        {
          const label = labelOf.get(el.id)
          if (label) fontDiff(label, compiledById.get(el.id + LABEL_SUFFIX) ?? defaultFont(board, el), style, hints)
        }
        break
    }
    finish(set, style, hints)
    if (Object.keys(set).length) updates.push({ op: 'update', id: el.id, set })
  }

  // Elements drawn by hand. Their style is whatever differs from a freshly compiled default.
  for (const ex of live) {
    if (boardById.has(ex.id) || !isRendered(ex)) continue
    if (ex.type === 'text' && ex.containerId && liveById.has(ex.containerId)) continue
    const element = newElement(ex, toBoardId(ex.id), labelOf.get(ex.id), endpointOf)
    if (!element) continue
    const [reference, referenceLabel] = compileBoard({ ...board, elements: [element] }).elements
    const style: Patch = {}
    const hints: Patch = {}
    // Keep the seed the user saw; a new board id would otherwise change the wobble.
    styleHintDiff(ex, { ...reference, seed: ex.seed }, style, hints, element.kind === 'node' || element.kind === 'edge')
    if (ex.type === 'text') fontDiff(ex, reference, style, hints)
    const label = labelOf.get(ex.id)
    if (label) fontDiff(label, referenceLabel ?? defaultFont(board, element), style, hints)
    if (element.kind === 'edge') Object.assign(hints, headOf(ex).hints)
    finish({}, style, hints)
    adds.push({ op: 'add', element: { ...element, style, hints: { seed: ex.seed, ...hints } } as BoardElement })
  }

  const groupOps = diffGroups(board, live, liveById, toBoardId)
  const structural = [...adds, ...updates, ...groupOps, ...removes]
  const intermediate = structural.length ? commit(board, structural).board : board
  return [...structural, ...diffOrder(intermediate, live, toBoardId, idFor)]
}

function diffHints(el: BoardElement, wanted: Patch): Patch {
  const out: Patch = {}
  for (const [k, v] of Object.entries(wanted)) if ((el.hints[k] ?? null) !== v) out[k] = v
  return out
}

function edgeChanges(
  el: EdgeElement,
  ex: ExElement,
  endpointOf: (b: ExElement['startBinding'], fallback: Point | undefined) => Endpoint | undefined,
): Patch {
  const set: Patch = {}
  const pts = absolutePoints(ex)
  const from = endpointOf(ex.startBinding, pts[0])
  const to = endpointOf(ex.endBinding, pts.at(-1))
  if (from && !sameEndpoint(from, el.from)) set.from = from
  if (to && !sameEndpoint(to, el.to)) set.to = to
  const via = pts.slice(1, -1)
  const current = el.via ?? []
  const viaChanged = via.length !== current.length || via.some((p, i) => !near(p.x, current[i].x) || !near(p.y, current[i].y))
  if (viaChanged) set.via = via.length ? via : null
  const { head } = headOf(ex)
  if (head !== el.head) set.head = head
  return set
}

const RENDERED = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw', 'image'])

function isRendered(ex: ExElement): boolean {
  return RENDERED.has(ex.type)
}

function newElement(
  ex: ExElement,
  id: Id,
  label: ExElement | undefined,
  endpointOf: (b: ExElement['startBinding'], fallback: Point | undefined) => Endpoint | undefined,
): BoardElement | undefined {
  const common = { id, style: {}, hints: {} }
  const at = { kind: 'at' as const, x: r2(ex.x), y: r2(ex.y) }
  switch (ex.type) {
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return { ...common, kind: 'node', label: label?.text ?? '', shape: shapeOf(ex), at, size: { w: r2(ex.width), h: r2(ex.height) } }
    case 'text':
      return { ...common, kind: 'text', text: ex.text ?? '', at }
    case 'arrow':
    case 'line': {
      const pts = absolutePoints(ex)
      if (pts.length < 2) return undefined
      const from = endpointOf(ex.startBinding, pts[0])!
      const to = endpointOf(ex.endBinding, pts.at(-1))!
      const via = pts.slice(1, -1)
      return {
        ...common,
        kind: 'edge',
        from,
        to,
        head: ex.type === 'line' ? '--' : headOf(ex).head,
        ...(label?.text && { label: label.text }),
        ...(via.length && { via }),
      }
    }
    case 'freedraw':
      if (!ex.points?.length) return undefined
      return { ...common, kind: 'draw', at: { x: r2(ex.x), y: r2(ex.y) }, path: pointsToPath(ex.points.map(([x, y]) => ({ x, y }))) }
    case 'image':
      if (!ex.fileId) return undefined
      return { ...common, kind: 'image', asset: ex.fileId, at, size: { w: r2(ex.width), h: r2(ex.height) } }
  }
  return undefined
}

/** Excalidraw groupIds (innermost first) back into board groups. */
function diffGroups(
  board: Board,
  live: ExElement[],
  liveById: Map<string, ExElement>,
  toBoardId: (exId: string) => Id,
): Op[] {
  const desired = new Map<Id, Id[]>()
  const addMember = (group: Id, member: Id) => {
    const list = desired.get(group) ?? []
    if (!list.includes(member)) list.push(member)
    desired.set(group, list)
  }
  for (const ex of live) {
    if (!isRendered(ex) || (ex.type === 'text' && ex.containerId && liveById.has(ex.containerId))) continue
    const chain = ex.groupIds.map(toBoardId)
    if (chain.length) addMember(chain[0], toBoardId(ex.id))
    for (let k = 0; k + 1 < chain.length; k++) addMember(chain[k + 1], chain[k])
  }

  const ops: Op[] = []
  for (const el of board.elements) {
    if (el.kind !== 'group') continue
    const want = desired.get(el.id)
    desired.delete(el.id)
    if (!want) {
      ops.push({ op: 'remove', id: el.id })
      continue
    }
    const same = want.length === el.members.length && want.every((m) => el.members.includes(m))
    if (!same) {
      const members = [...el.members.filter((m) => want.includes(m)), ...want.filter((m) => !el.members.includes(m))]
      ops.push({ op: 'update', id: el.id, set: { members } })
    }
  }
  for (const [id, members] of desired) {
    ops.push({ op: 'add', element: { kind: 'group', id, members, style: {}, hints: {} } })
  }
  return ops
}

/** Minimal reorders (keeping the longest already-ordered run) to match the scene's z-order. */
function diffOrder(board: Board, live: ExElement[], toBoardId: (exId: string) => Id, idFor: Map<string, Id>): Op[] {
  const present = new Set(board.elements.filter((e) => e.kind !== 'group').map((e) => e.id))
  const desired: Id[] = []
  for (const ex of live) {
    if (ex.id.endsWith(LABEL_SUFFIX) || (ex.type === 'text' && ex.containerId)) continue
    const id = idFor.get(ex.id) ?? (isRendered(ex) ? toBoardId(ex.id) : undefined)
    if (id && present.has(id) && !desired.includes(id)) desired.push(id)
  }
  const current = board.elements.filter((e) => desired.includes(e.id)).map((e) => e.id)
  const pos = desired.map((id) => current.indexOf(id))
  const keep = longestIncreasing(pos)
  const ops: Op[] = []
  desired.forEach((id, i) => {
    if (!keep.has(i)) ops.push({ op: 'reorder', id, after: i > 0 ? desired[i - 1] : null })
  })
  return ops
}
