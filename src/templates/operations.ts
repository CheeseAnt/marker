import { DEFAULT_STROKE, STICKY_FILL } from '../compile/exTypes'
import { resolveBoxes, unionBoxes, type Box } from '../model/geometry'
import type { Op } from '../model/ops'
import { parsePath, pointsToPath } from '../model/path'
import {
  templateKey,
  type Board,
  type BoardElement,
  type Endpoint,
  type Id,
  type InstanceElement,
  type Placement,
  type PortSide,
  type TemplateKey,
} from '../model/types'

/** A template as stored in the library: its board and any templates it uses (flat). */
export interface TemplateVersion {
  name: string
  version: number
  board: Board
}

/** `define` ops for a template and the templates inside it that the board doesn't have yet. */
export function definitionOps(board: Board, t: TemplateVersion): Op[] {
  const ops: Op[] = []
  const add = (key: TemplateKey, def: Board) => {
    if (board.definitions[key]) return
    ops.push({ op: 'define', key, board: { ...def, definitions: {} } as never })
  }
  for (const [key, def] of Object.entries(t.board.definitions)) add(key, def)
  add(templateKey(t.name, t.version), t.board)
  return ops
}

/** A fresh id for a copy of `name`: server1, server2, ... */
export function nextCopyId(board: Board, name: string): Id {
  const taken = new Set(board.elements.map((e) => e.id))
  for (let n = 1; ; n++) if (!taken.has(`${name}${n}`)) return `${name}${n}`
}

export function insertCopyOps(
  board: Board,
  t: TemplateVersion,
  opts: { id?: Id; at?: Placement; params?: Record<string, string>; scale?: number } = {},
): Op[] {
  const instance: InstanceElement = {
    kind: 'instance',
    id: opts.id ?? nextCopyId(board, t.name),
    template: templateKey(t.name, t.version),
    params: opts.params ?? {},
    overrides: {},
    style: {},
    hints: {},
    ...(opts.at && { at: opts.at }),
    ...(opts.scale !== undefined && { scale: opts.scale }),
  }
  return [...definitionOps(board, t), { op: 'add', element: instance }]
}

export interface UpdateReport {
  ops: Op[]
  copies: Id[]
  /** Params and overrides the new version has no place for, written for the user. */
  dropped: string[]
}

/** Moves every copy of `t.name` on the board (or just those in `ids`) to version `t.version`. */
export function updateCopiesOps(board: Board, t: TemplateVersion, ids?: Id[]): UpdateReport {
  const key = templateKey(t.name, t.version)
  const copies = board.elements.filter(
    (e): e is InstanceElement =>
      e.kind === 'instance' && e.template.startsWith(`${t.name}@`) && e.template !== key && (!ids || ids.includes(e.id)),
  )
  const ops = definitionOps(board, t)
  const spec = t.board.template!
  const children = new Set(t.board.elements.map((e) => e.id))
  const dropped: string[] = []
  for (const copy of copies) {
    const params = Object.fromEntries(Object.entries(copy.params).filter(([k]) => spec.params.some((p) => p.name === k)))
    const overrides = Object.fromEntries(Object.entries(copy.overrides).filter(([path]) => children.has(path.split('/')[0])))
    for (const k of Object.keys(copy.params)) if (!(k in params)) dropped.push(`${copy.id}: value for “${k}”`)
    for (const k of Object.keys(copy.overrides)) if (!(k in overrides)) dropped.push(`${copy.id}: changes to “${k}”`)
    ops.push({ op: 'update', id: copy.id, set: { template: key, params, overrides } })
  }
  return { ops, copies: copies.map((c) => c.id), dropped }
}

export interface TemplateDraft {
  name: string
  /** The name as the user wrote it, used as the template board's title. */
  title?: string
  description: string
  /** Text elements (by board id) whose text becomes a parameter. */
  params: { element: Id; name: string }[]
  /** Colours (an element's fill or stroke) each copy can change, as params. */
  colours?: { element: Id; key: 'fill' | 'stroke'; name: string }[]
  ports: { element: Id; name: string; side: PortSide }[]
}

/** The colour an element shows for `key`, from its own style or the board's. */
export function colourOf(board: Board, el: BoardElement, key: 'fill' | 'stroke'): string {
  return el.style[key] ?? board.defaults[key] ?? (key === 'stroke' ? DEFAULT_STROKE : el.kind === 'node' && el.shape === 'sticky' ? STICKY_FILL : 'transparent')
}

/** The selected elements plus what belongs with them: edges between them and their groups. */
export function expandSelection(board: Board, ids: Id[]): Id[] {
  const picked = new Set(ids)
  // Selecting a group selects its members.
  for (let grew = true; grew; ) {
    grew = false
    for (const el of board.elements) {
      if (el.kind !== 'group' || !picked.has(el.id)) continue
      for (const m of el.members) {
        if (picked.has(m)) continue
        picked.add(m)
        grew = true
      }
    }
  }
  for (const el of board.elements) {
    if (el.kind === 'edge') {
      const inside = (e: Endpoint) => 'point' in e || picked.has(e.id)
      if (inside(el.from) && inside(el.to) && ('id' in el.from || 'id' in el.to)) picked.add(el.id)
    }
  }
  for (const el of board.elements) {
    if (el.kind === 'group' && el.members.every((m) => picked.has(m))) picked.add(el.id)
  }
  return board.elements.filter((e) => picked.has(e.id)).map((e) => e.id)
}

function textOf(el: BoardElement): string | undefined {
  return el.kind === 'node' || el.kind === 'edge' ? el.label : el.kind === 'text' ? el.text : undefined
}

/**
 * Builds a template board from selected elements: positions are made absolute from the
 * selection's top-left corner, chosen texts become `{param}` placeholders, and any templates
 * the selection uses come along as definitions.
 */
export function templateFromSelection(board: Board, ids: Id[], draft: TemplateDraft): { template: Board; bounds: Box } {
  const picked = new Set(expandSelection(board, ids))
  const boxes = resolveBoxes(board)
  const elements = board.elements.filter((e) => picked.has(e.id))
  const bounds = unionBoxes(elements.filter((e) => e.kind !== 'group' && e.kind !== 'edge').flatMap((e) => boxes.get(e.id) ?? [])) ?? { x: 0, y: 0, w: 0, h: 0 }
  const shift = (p: { x: number; y: number }) => ({ x: round(p.x - bounds.x), y: round(p.y - bounds.y) })
  const paramFor = new Map(draft.params.map((p) => [p.element, p.name]))

  const content = elements.map((el): BoardElement => {
    let next: BoardElement = el
    const box = boxes.get(el.id)
    if ((el.kind === 'node' || el.kind === 'text' || el.kind === 'image' || el.kind === 'instance') && box) {
      next = { ...el, at: { kind: 'at', ...shift(box) } } as BoardElement
    }
    if (el.kind === 'draw') next = { ...el, at: shift(el.at), path: pointsToPath(parsePath(el.path).points) }
    if (el.kind === 'edge') {
      const end = (e: Endpoint): Endpoint => ('point' in e ? { point: shift(e.point) } : e)
      next = { ...el, from: end(el.from), to: end(el.to), ...(el.via && { via: el.via.map(shift) }) }
    }
    const param = paramFor.get(el.id)
    if (param) {
      if (next.kind === 'node' || next.kind === 'edge') next = { ...next, label: `{${param}}` }
      else if (next.kind === 'text') next = { ...next, text: `{${param}}` }
    }
    for (const c of draft.colours ?? []) if (c.element === el.id) next = { ...next, style: { ...next.style, [c.key]: `{${c.name}}` } }
    return next
  })

  const used = new Set(content.flatMap((e) => (e.kind === 'instance' ? [e.template] : [])))
  const definitions: Board['definitions'] = {}
  // Nested templates are carried along, including the ones they use in turn.
  for (const key of used) collectDefinitions(board, key, definitions)

  const template: Board = {
    title: draft.title || draft.name,
    formatVersion: board.formatVersion,
    defaults: board.defaults,
    elements: content,
    template: {
      name: draft.name,
      description: draft.description,
      params: [
        ...draft.params.map((p) => ({ name: p.name, default: textOf(board.elements.find((e) => e.id === p.element)!) ?? '' })),
        ...(draft.colours ?? []).map((c) => ({ name: c.name, default: colourOf(board, board.elements.find((e) => e.id === c.element)!, c.key) })),
      ],
      ports: draft.ports.map((p) => ({ name: p.name, target: p.element, side: p.side })),
    },
    definitions,
  }
  return { template, bounds }
}

/** Copies `key`'s definition and every definition it needs, from `board` into `into`. */
export function collectDefinitions(board: Board, key: TemplateKey, into: Board['definitions']) {
  if (into[key] || !board.definitions[key]) return
  into[key] = board.definitions[key]
  for (const el of board.definitions[key].elements) if (el.kind === 'instance') collectDefinitions(board, el.template, into)
}

/**
 * Replaces the selection with a copy of its new template, in the same place. Edges from
 * outside move to the copy, to the port on their element when it has one.
 */
export function replaceWithCopyOps(board: Board, ids: Id[], t: TemplateVersion, bounds: Box): Op[] {
  const picked = new Set(expandSelection(board, ids))
  const id = nextCopyId(board, t.name)
  const portOn = new Map(t.board.template!.ports.map((p) => [p.target, p.name]))
  const ops: Op[] = insertCopyOps(board, t, { id, at: { kind: 'at', x: round(bounds.x), y: round(bounds.y) } })
  for (const el of board.elements) {
    if (el.kind !== 'edge' || picked.has(el.id)) continue
    const move = (e: Endpoint): Endpoint | undefined => {
      if (!('id' in e) || !picked.has(e.id)) return undefined
      const port = portOn.get(e.id)
      return port ? { id, port } : { id }
    }
    const from = move(el.from)
    const to = move(el.to)
    if (from || to) ops.push({ op: 'update', id: el.id, set: { ...(from && { from }), ...(to && { to }) } })
  }
  for (const el of board.elements) if (picked.has(el.id) && el.kind !== 'edge') ops.push({ op: 'remove', id: el.id })
  return ops
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** "Web server" -> web_server; identifiers are what the board text uses. */
export function toIdentifier(text: string, fallback: string): string {
  const id = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  return /^[a-z_]/.test(id) ? id : id ? `t_${id}` : fallback
}
