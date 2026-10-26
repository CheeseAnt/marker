import { commit } from '../model/apply'
import { detachOps } from '../templates/detach'
import { ownerInstance } from '../templates/expand'
import { longestIncreasing } from '../model/diffBoards'
import { DEFAULT_FONT_SIZE, effectiveStyle } from '../model/geometry'
import type { Op } from '../model/ops'
import { pointsToPath } from '../model/path'
import {
  idSchema,
  shapes,
  type Board,
  type BoardElement,
  type EdgeElement,
  type InstanceElement,
  type Override,
  type Endpoint,
  type Head,
  type Id,
  type Point,
} from '../model/types'
import { DEFAULT_FONT, fontForFamily, fontPreset } from '../model/fonts'
import { CYLINDER_PARTS, cropToHint, FILL_STYLE, flipToHint, LABEL_SUFFIX, partOwner, type ExElement } from './exTypes'
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

/**
 * What a label says. Excalidraw wraps text to fit its shape, and keeps what was typed as
 * `originalText`; wrapping again (say, after a resize) is not an edit.
 */
function textOf(ex: ExElement | undefined): string {
  return ex?.originalText ?? ex?.text ?? ''
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

/** What happened to a template copy on the canvas. */
type CopyChange = { kind: 'none' } | { kind: 'update'; set: Patch } | { kind: 'remove' } | { kind: 'detach' } | { kind: 'reject' }

/** The child path of a compiled id inside its copy: "web1/b~label" -> "b". */
function childPath(instanceId: Id, compiledId: string): string {
  const path = compiledId.slice(instanceId.length + 1)
  return path.endsWith(LABEL_SUFFIX) ? path.slice(0, -LABEL_SUFFIX.length) : (partOwner(path) ?? path)
}

function boundsOf(els: ExElement[]) {
  const shapes = els.filter((e) => !(e.type === 'text' && e.containerId))
  const x1 = Math.min(...shapes.map((e) => e.x))
  const y1 = Math.min(...shapes.map((e) => e.y))
  const x2 = Math.max(...shapes.map((e) => e.x + e.width))
  const y2 = Math.max(...shapes.map((e) => e.y + e.height))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * A copy can be moved or scaled as a whole, have its texts and styles changed (stored as
 * overrides), be deleted, or be ungrouped (which detaches it). Moving or deleting single parts
 * would break the link to its template, so that is rejected and the canvas reverts.
 */
function copyChanges(el: InstanceElement, compiled: ExElement[], liveById: Map<string, ExElement>, box: { x: number; y: number } | undefined): CopyChange {
  const parts = compiled.filter((c) => c.id.startsWith(`${el.id}/`))
  if (parts.length === 0) return { kind: 'none' }
  const live = parts.map((c) => liveById.get(c.id))
  if (live.every((e) => !e)) return { kind: 'remove' }
  if (live.some((e) => !e)) return { kind: 'reject' }
  const now = live as ExElement[]
  if (now.some((e) => !e.groupIds.includes(el.id))) return { kind: 'detach' }

  const set: Patch = {}
  const before = boundsOf(parts)
  const after = boundsOf(now)
  const rx = before.w ? after.w / before.w : 1
  const ry = before.h ? after.h / before.h : 1
  if (Math.abs(rx - ry) > 0.02) return { kind: 'reject' }
  const ratio = Math.abs(rx - 1) > 0.01 ? rx : 1
  // Every part must sit where moving and scaling the whole copy would put it.
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i]
    const e = now[i]
    if (c.type === 'text' && c.containerId) continue
    const x = after.x + (c.x - before.x) * ratio
    const y = after.y + (c.y - before.y) * ratio
    if (Math.abs(e.x - x) > 1 || Math.abs(e.y - y) > 1) return { kind: 'reject' }
  }
  if (ratio !== 1) set.scale = r2((el.scale ?? 1) * ratio)
  if (ratio !== 1 || !near(after.x, before.x) || !near(after.y, before.y)) {
    const origin = box ?? before
    set.at = { kind: 'at', x: r2(after.x + (origin.x - before.x) * ratio), y: r2(after.y + (origin.y - before.y) * ratio) }
  }

  // Text and style changes on parts become overrides.
  const scale = el.scale ?? 1
  const overrides: Record<string, Override> = structuredClone(el.overrides)
  let overridden = false
  const note = (path: string, change: Override) => {
    const o = (overrides[path] ??= {})
    if (change.text !== undefined) o.text = change.text
    if (change.style) o.style = { ...o.style, ...change.style }
    overridden = true
  }
  parts.forEach((c, i) => {
    const e = now[i]
    const path = childPath(el.id, c.id)
    if (e.text !== undefined && textOf(e) !== textOf(c)) note(path, { text: textOf(e) })
    const style: Patch = {}
    if (!(c.type === 'text' && c.containerId)) {
      for (const [prop, key] of STYLE_PROPS) if (e[prop] !== c[prop]) style[key] = e[prop]
      if (e.fillStyle !== c.fillStyle) style.pattern = PATTERN_OF[e.fillStyle] ?? 'solid'
    }
    if (e.type === 'text') {
      if (e.fontSize !== c.fontSize && e.fontSize) style.fontSize = r2(e.fontSize / scale)
      if (e.fontFamily !== c.fontFamily) style.font = fontForFamily(e.fontFamily) ?? DEFAULT_FONT
    }
    if (Object.keys(style).length) note(path, { style: style as Override['style'] })
  })
  if (overridden) set.overrides = overrides
  return Object.keys(set).length ? { kind: 'update', set } : { kind: 'none' }
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
export function diffScene(ctx: DiffContext): Op[] {
  return diffSceneDetailed(ctx).ops
}

export interface SceneDiff {
  ops: Op[]
  /** Template copies whose parts were changed in a way that isn't kept; the canvas should revert. */
  rejected: Id[]
}

export function diffSceneDetailed({ board, compiled, scene }: DiffContext): SceneDiff {
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
    // An arrow attached to part of a cylinder attaches to the cylinder.
    const boundId = binding && (partOwner(binding.elementId) ?? binding.elementId)
    const target = boundId && liveById.get(boundId)
    if (target && isRendered(target)) {
      // A part of a template copy: attach to the port on that part, or to the copy itself.
      const owner = ownerInstance(target.id)
      if (owner) {
        const inst = boardById.get(owner.instance)
        const spec = inst?.kind === 'instance' ? board.definitions[inst.template]?.template : undefined
        const port = spec?.ports.find((p) => p.target === owner.child.split('/')[0])
        return port ? { id: owner.instance, port: port.name } : { id: owner.instance }
      }
      return { id: toBoardId(target.id) }
    }
    return fallback && { point: fallback }
  }

  const adds: Op[] = []
  const updates: Op[] = []
  const removes: Op[] = []
  const rejected: Id[] = []

  const detached: Id[] = []
  for (const el of board.elements) {
    if (el.kind === 'group') continue
    if (el.kind === 'instance') {
      const change = copyChanges(el, compiled.elements, liveById, compiled.boxes.get(el.id))
      if (change.kind === 'remove') removes.push({ op: 'remove', id: el.id })
      else if (change.kind === 'update') updates.push({ op: 'update', id: el.id, set: change.set })
      else if (change.kind === 'detach') detached.push(el.id)
      else if (change.kind === 'reject') rejected.push(el.id)
      continue
    }
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
        // A cylinder's own element is a rectangle, but that doesn't make it one.
        if (shape !== el.shape && el.shape !== 'cylinder' && shapes.includes(shape)) set.shape = shape
        // A cylinder's own element only covers its middle; its outline has the whole box.
        const outline = el.shape === 'cylinder' ? el.id + CYLINDER_PARTS[0] : el.id
        const [now, was] = [liveById.get(outline) ?? ex, compiledById.get(outline) ?? c]
        const resized = !near(now.width, was.width) || !near(now.height, was.height)
        if (resized) set.size = { w: r2(now.width), h: r2(now.height) }
        // Relative placement is centred on the anchor, so a resize must pin the node or it would jump.
        if (!near(now.x, was.x) || !near(now.y, was.y) || (resized && el.at?.kind !== 'at')) {
          set.at = { kind: 'at', x: r2(now.x), y: r2(now.y) }
        }
        if (el.shape === 'cylinder') {
          // The outline shows the cylinder's style; its own rectangle is invisible.
          const [body, compiledBody] = [liveById.get(el.id + CYLINDER_PARTS[0]), compiledById.get(el.id + CYLINDER_PARTS[0])]
          if (body && compiledBody) styleHintDiff(body, compiledBody, style, hints)
          if (ex.seed !== c.seed) hints.seed = ex.seed
        } else styleHintDiff(ex, c, style, hints)
        const label = labelOf.get(el.id)
        if (textOf(label) !== el.label) set.label = textOf(label)
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
        if (cropToHint(ex.crop) !== cropToHint(c.crop)) hints.crop = cropToHint(ex.crop)
        if (flipToHint(ex.scale) !== flipToHint(c.scale)) hints.flip = flipToHint(ex.scale)
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
      case 'frame':
        // A frame moved or resized by hand keeps that box instead of fitting its members.
        if (!near(ex.x, c.x) || !near(ex.y, c.y) || !near(ex.width, c.width) || !near(ex.height, c.height)) {
          set.at = { x: r2(ex.x), y: r2(ex.y) }
          set.size = { w: r2(ex.width), h: r2(ex.height) }
        }
        if ((ex.name ?? '') !== el.label) set.label = ex.name ?? ''
        break
      case 'edge':
        Object.assign(set, edgeChanges(el, ex, c, endpointOf))
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
    if (boardById.has(ex.id) || !isRendered(ex) || ownerInstance(ex.id) || isCylinderPart(ex.id, boardById)) continue
    if (ex.type === 'text' && ex.containerId && liveById.has(ex.containerId)) continue
    const element = newElement(ex, toBoardId(ex.id), labelOf.get(ex.id), endpointOf)
    if (!element) continue
    if (element.kind === 'frame') {
      adds.push({ op: 'add', element: { ...element, hints: { seed: ex.seed } } })
      continue
    }
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

  const frameOps = diffFrames(board, live, adds, toBoardId)
  const groupOps = diffGroups(board, live, liveById, toBoardId)
  const structural = [...adds, ...updates, ...frameOps, ...groupOps, ...removes]
  let intermediate = structural.length ? commit(board, structural).board : board
  // Ungrouping a copy detaches it; its parts take their place in the board as ordinary elements.
  const detachOpsList = detached.flatMap((id) => detachOps(intermediate, id, { keepGrouped: false }))
  if (detachOpsList.length) intermediate = commit(intermediate, detachOpsList).board
  const ops = [...structural, ...detachOpsList, ...(detached.length ? [] : diffOrder(intermediate, live, toBoardId, idFor))]
  return { ops, rejected }
}

function diffHints(el: BoardElement, wanted: Patch): Patch {
  const out: Patch = {}
  for (const [k, v] of Object.entries(wanted)) if ((el.hints[k] ?? null) !== v) out[k] = v
  return out
}

function edgeChanges(
  el: EdgeElement,
  ex: ExElement,
  c: ExElement,
  endpointOf: (b: ExElement['startBinding'], fallback: Point | undefined) => Endpoint | undefined,
): Patch {
  const set: Patch = {}
  const pts = absolutePoints(ex)
  const was = absolutePoints(c)
  // An end we drew unbound (e.g. to a template copy without a port) is unchanged if it hasn't moved.
  const unmoved = (binding: ExElement['startBinding'], compiledBinding: ExElement['startBinding'], p?: Point, q?: Point) =>
    !binding && !compiledBinding && p && q && near(p.x, q.x) && near(p.y, q.y)
  const from = unmoved(ex.startBinding, c.startBinding, pts[0], was[0]) ? el.from : endpointOf(ex.startBinding, pts[0])
  const to = unmoved(ex.endBinding, c.endBinding, pts.at(-1), was.at(-1)) ? el.to : endpointOf(ex.endBinding, pts.at(-1))
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

function isCylinderPart(exId: string, boardById: Map<Id, BoardElement>): boolean {
  const owner = partOwner(exId)
  const el = owner ? boardById.get(owner) : undefined
  return el?.kind === 'node' && el.shape === 'cylinder'
}

const RENDERED = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw', 'image', 'frame'])

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
      return { ...common, kind: 'node', label: textOf(label), shape: shapeOf(ex), at, size: { w: r2(ex.width), h: r2(ex.height) } }
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
    case 'frame':
      // Members are filled in from the scene's frameIds (see diffFrames).
      return { ...common, kind: 'frame', label: ex.name ?? '', members: [], at: { x: r2(ex.x), y: r2(ex.y) }, size: { w: r2(ex.width), h: r2(ex.height) } }
    case 'image':
      if (!ex.fileId) return undefined
      return { ...common, kind: 'image', asset: ex.fileId, at, size: { w: r2(ex.width), h: r2(ex.height) } }
  }
  return undefined
}

/**
 * Frame membership from the scene: Excalidraw puts an element in a frame (frameId) when it's
 * drawn or dropped inside one. New frames get their members on the add op itself.
 */
function diffFrames(board: Board, live: ExElement[], adds: Op[], toBoardId: (exId: string) => Id): Op[] {
  const boardById = new Map(board.elements.map((e) => [e.id, e]))
  const want = new Map<Id, Id[]>()
  for (const ex of live) {
    if (!ex.frameId || !isRendered(ex) || ex.type === 'frame' || (ex.type === 'text' && ex.containerId)) continue
    if (ex.id.endsWith(LABEL_SUFFIX)) continue
    const member = isCylinderPart(ex.id, boardById) ? partOwner(ex.id)! : (ownerInstance(ex.id)?.instance ?? toBoardId(ex.id))
    const frame = toBoardId(ex.frameId)
    const list = want.get(frame) ?? []
    if (!list.includes(member)) list.push(member)
    want.set(frame, list)
  }
  for (const op of adds) if (op.op === 'add' && op.element.kind === 'frame') op.element.members = want.get(op.element.id) ?? []
  const ops: Op[] = []
  for (const el of board.elements) {
    if (el.kind !== 'frame') continue
    const members = want.get(el.id) ?? []
    const same = members.length === el.members.length && members.every((m) => el.members.includes(m))
    if (!same) ops.push({ op: 'update', id: el.id, set: { members: [...el.members.filter((m) => members.includes(m)), ...members.filter((m) => !el.members.includes(m))] } })
  }
  return ops
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
    if (!isRendered(ex) || ex.type === 'frame' || (ex.type === 'text' && ex.containerId && liveById.has(ex.containerId))) continue
    // A cylinder's parts are grouped under its own id; the cylinder itself stands for them.
    if (isCylinderPart(ex.id, new Map(board.elements.map((e) => [e.id, e])))) continue
    // A copy's parts stand for the copy: only groups outside it (after its own id) count.
    const owner = ownerInstance(ex.id)
    const member = owner ? owner.instance : toBoardId(ex.id)
    const own = owner ? ex.groupIds.slice(ex.groupIds.indexOf(owner.instance) + 1) : ex.groupIds
    const groupIds = own[0] === ex.id ? own.slice(1) : own
    if (owner && !ex.groupIds.includes(owner.instance)) continue
    const chain = groupIds.map(toBoardId)
    if (chain.length) addMember(chain[0], member)
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
  const present = new Set(board.elements.filter((e) => e.kind !== 'group' && e.kind !== 'frame').map((e) => e.id))
  const desired: Id[] = []
  for (const ex of live) {
    if (ex.id.endsWith(LABEL_SUFFIX) || (ex.type === 'text' && ex.containerId) || partOwner(ex.id)) continue
    const owner = ownerInstance(ex.id)
    const id = owner ? owner.instance : (idFor.get(ex.id) ?? (isRendered(ex) ? toBoardId(ex.id) : undefined))
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
