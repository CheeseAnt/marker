import { resolveBoxes } from './geometry'
import { FIXED_FIELDS, MERGED_FIELDS, type Op } from './ops'
import { definitionCycle, usedDefinitions } from '../templates/expand'
import { definitionSchema, elementSchema, parseTemplateKey, type Board, type BoardElement, type Id, type InstanceElement } from './types'

export class OpError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('\n'))
    this.name = 'OpError'
    this.issues = issues
  }
}

export interface Applied {
  board: Board
  /** Ops actually applied, including cascades, in order. */
  ops: Op[]
  /** Ops that revert `ops`, already in the order to apply them. */
  inverse: Op[]
}

function indexOf(board: Board, id: Id): number {
  return board.elements.findIndex((e) => e.id === id)
}

function predecessor(board: Board, idx: number): Id | null {
  return idx > 0 ? board.elements[idx - 1].id : null
}

function insertIndex(elements: BoardElement[], after: Id | null | undefined): number {
  if (after === undefined) return elements.length
  if (after === null) return 0
  const idx = elements.findIndex((e) => e.id === after)
  if (idx < 0) throw new OpError([`"after" refers to unknown element "${after}"`])
  return idx + 1
}

function applyUpdate(el: BoardElement, set: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...el }
  const prev: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(set)) {
    if ((FIXED_FIELDS as readonly string[]).includes(key)) {
      throw new OpError([`cannot change "${key}" of "${el.id}"; remove and re-add it instead`])
    }
    const current = (el as Record<string, unknown>)[key]
    if ((MERGED_FIELDS as readonly string[]).includes(key)) {
      if (value === null || typeof value !== 'object') {
        throw new OpError([`"${key}" of "${el.id}" must be an object of changes`])
      }
      const merged: Record<string, unknown> = { ...(current as Record<string, unknown>) }
      const prevSub: Record<string, unknown> = {}
      for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
        prevSub[sub] = merged[sub] === undefined ? null : merged[sub]
        if (v === null) delete merged[sub]
        else merged[sub] = v
      }
      next[key] = merged
      prev[key] = prevSub
    } else {
      prev[key] = current === undefined ? null : current
      if (value === null) delete next[key]
      else next[key] = value
    }
  }
  const parsed = elementSchema.safeParse(next)
  if (!parsed.success) {
    throw new OpError(parsed.error.issues.map((i) => `"${el.id}" ${i.path.join('.')}: ${i.message}`))
  }
  return { next: parsed.data, prev }
}

/** Applies one op without cascading or integrity checks. */
export function applyOp(board: Board, op: Op): { board: Board; inverse: Op } {
  const elements = [...board.elements]
  switch (op.op) {
    case 'add': {
      const element = elementSchema.parse(op.element)
      if (indexOf(board, element.id) >= 0) throw new OpError([`id "${element.id}" already exists`])
      elements.splice(insertIndex(elements, op.after), 0, element)
      return { board: { ...board, elements }, inverse: { op: 'remove', id: element.id } }
    }
    case 'update': {
      const idx = indexOf(board, op.id)
      if (idx < 0) throw new OpError([`cannot update unknown element "${op.id}"`])
      const { next, prev } = applyUpdate(elements[idx], op.set)
      elements[idx] = next
      return { board: { ...board, elements }, inverse: { op: 'update', id: op.id, set: prev } }
    }
    case 'remove': {
      const idx = indexOf(board, op.id)
      if (idx < 0) throw new OpError([`cannot remove unknown element "${op.id}"`])
      const [removed] = elements.splice(idx, 1)
      return {
        board: { ...board, elements },
        inverse: { op: 'add', element: removed, after: predecessor(board, idx) },
      }
    }
    case 'reorder': {
      const idx = indexOf(board, op.id)
      if (idx < 0) throw new OpError([`cannot reorder unknown element "${op.id}"`])
      if (op.after === op.id) throw new OpError([`cannot place "${op.id}" after itself`])
      const prevAfter = predecessor(board, idx)
      const [moved] = elements.splice(idx, 1)
      elements.splice(insertIndex(elements, op.after), 0, moved)
      return { board: { ...board, elements }, inverse: { op: 'reorder', id: op.id, after: prevAfter } }
    }
    case 'replace': {
      const element = elementSchema.parse(op.element)
      const idx = indexOf(board, element.id)
      if (idx < 0) throw new OpError([`cannot replace unknown element "${element.id}"`])
      const old = elements[idx]
      elements[idx] = element
      return { board: { ...board, elements }, inverse: { op: 'replace', element: old } }
    }
    case 'board': {
      const prev: { title?: string; defaults?: Board['defaults'] } = {}
      const next = { ...board }
      if (op.set.title !== undefined) {
        prev.title = board.title
        next.title = op.set.title
      }
      if (op.set.defaults !== undefined) {
        prev.defaults = board.defaults
        next.defaults = op.set.defaults
      }
      return { board: next, inverse: { op: 'board', set: prev } }
    }
    case 'define': {
      const def = definitionSchema.parse(op.board)
      const prev = board.definitions[op.key]
      const { name } = parseTemplateKey(op.key)
      if (def.template.name !== name) throw new OpError([`definition ${op.key} is for template "${def.template.name}"`])
      return {
        board: { ...board, definitions: { ...board.definitions, [op.key]: def } },
        inverse: prev ? { op: 'define', key: op.key, board: prev as never } : { op: 'undefine', key: op.key },
      }
    }
    case 'undefine': {
      const prev = board.definitions[op.key]
      if (!prev) throw new OpError([`there is no template ${op.key} to remove`])
      const definitions = { ...board.definitions }
      delete definitions[op.key]
      return { board: { ...board, definitions }, inverse: { op: 'define', key: op.key, board: prev as never } }
    }
  }
}

/** Ops needed before removing `id` so nothing is left pointing at it. */
function cascadeFor(board: Board, id: Id): Op[] {
  const ops: Op[] = []
  let boxes: ReturnType<typeof resolveBoxes> | undefined
  for (const el of board.elements) {
    if (el.id === id) continue
    if (el.kind === 'edge') {
      const touches = [el.from, el.to].some((end) => 'id' in end && end.id === id)
      if (touches) ops.push({ op: 'remove', id: el.id })
    } else if (el.kind === 'group' && el.members.includes(id)) {
      const members = el.members.filter((m) => m !== id)
      ops.push(members.length ? { op: 'update', id: el.id, set: { members } } : { op: 'remove', id: el.id })
    } else if (el.kind === 'frame' && el.members.includes(id)) {
      // An emptied frame stays: it is a named area, and can be filled again.
      ops.push({ op: 'update', id: el.id, set: { members: el.members.filter((m) => m !== id) } })
    } else if ('at' in el && el.at && 'kind' in el.at && el.at.kind === 'rel' && el.at.of === id) {
      // Keep dependents where they are by pinning them to their current position.
      boxes ??= resolveBoxes(board)
      const box = boxes.get(el.id)
      if (box) ops.push({ op: 'update', id: el.id, set: { at: { kind: 'at', x: box.x, y: box.y } } })
    }
  }
  return ops
}

/** Structural problems that individual ops cannot see. Messages are written for the LLM. */
export function checkBoard(board: Board, opts: { definitions?: boolean } = {}): string[] {
  const issues: string[] = []
  const byId = new Map<Id, BoardElement>()
  for (const el of board.elements) {
    if (byId.has(el.id)) issues.push(`duplicate id "${el.id}"`)
    byId.set(el.id, el)
  }
  const isAnchor = (el: BoardElement | undefined) =>
    !!el && (el.kind === 'node' || el.kind === 'text' || el.kind === 'image' || el.kind === 'draw' || el.kind === 'instance')

  const parentOf = new Map<Id, Id>()
  const frameOf = new Map<Id, Id>()
  for (const el of board.elements) {
    if (el.kind === 'edge') {
      for (const [side, end] of [['from', el.from], ['to', el.to]] as const) {
        if (!('id' in end)) continue
        const target = byId.get(end.id)
        if (!isAnchor(target)) {
          issues.push(`edge "${el.id}" ${side} "${end.id}" is not a node, text, image, drawing or template copy`)
        } else if (end.port !== undefined) {
          const spec = target?.kind === 'instance' ? board.definitions[target.template]?.template : undefined
          if (!spec) issues.push(`edge "${el.id}" ${side} "${end.id}.${end.port}": only template copies have ports`)
          else if (!spec.ports.some((p) => p.name === end.port)) {
            issues.push(`edge "${el.id}" ${side}: ${spec.name} has no port "${end.port}" (it has ${spec.ports.map((p) => p.name).join(', ') || 'none'})`)
          }
        }
      }
    }
    if (el.kind === 'instance') issues.push(...checkInstance(board, el))
    if ((el.kind === 'node' || el.kind === 'text' || el.kind === 'image' || el.kind === 'instance') && el.at?.kind === 'rel') {
      if (!isAnchor(byId.get(el.at.of))) issues.push(`"${el.id}" is placed ${el.at.dir} unknown "${el.at.of}"`)
    }
    if (el.kind === 'frame') {
      for (const m of el.members) {
        const member = byId.get(m)
        if (!member) issues.push(`frame "${el.id}" has unknown member "${m}"`)
        else if (member.kind === 'frame') issues.push(`frame "${el.id}" can't contain frame "${m}"`)
        if (frameOf.has(m)) issues.push(`"${m}" is in both frames "${frameOf.get(m)}" and "${el.id}"`)
        frameOf.set(m, el.id)
      }
    }
    if (el.kind === 'group') {
      for (const m of el.members) {
        const member = byId.get(m)
        if (!member) issues.push(`group "${el.id}" has unknown member "${m}"`)
        else if (member.kind === 'frame') issues.push(`group "${el.id}" can't contain frame "${m}"`)
        if (parentOf.has(m)) issues.push(`"${m}" is in both groups "${parentOf.get(m)}" and "${el.id}"`)
        parentOf.set(m, el.id)
      }
    }
  }

  // Cycles in relative placement or group nesting.
  const anchorOf = (id: Id): Id | undefined => {
    const el = byId.get(id)
    return el && (el.kind === 'node' || el.kind === 'text' || el.kind === 'image' || el.kind === 'instance') && el.at?.kind === 'rel'
      ? el.at.of
      : undefined
  }
  for (const [label, next] of [['placement', anchorOf], ['group nesting', (id: Id) => parentOf.get(id)]] as const) {
    for (const el of board.elements) {
      const seen = new Set<Id>([el.id])
      for (let cur = next(el.id); cur; cur = next(cur)) {
        if (cur === el.id) {
          issues.push(`${label} cycle through "${el.id}"`)
          break
        }
        if (seen.has(cur)) break
        seen.add(cur)
      }
    }
  }
  issues.push(...checkTemplates(board, opts.definitions ?? true))
  return issues
}

function checkInstance(board: Board, el: InstanceElement): string[] {
  const def = board.definitions[el.template]
  if (!def) return [`"${el.id}" uses template ${el.template}, which this board doesn't define`]
  const issues: string[] = []
  const spec = def.template!
  for (const name of Object.keys(el.params)) {
    if (!spec.params.some((p) => p.name === name)) {
      issues.push(`"${el.id}": ${spec.name} has no parameter "${name}" (it has ${spec.params.map((p) => p.name).join(', ') || 'none'})`)
    }
  }
  for (const path of Object.keys(el.overrides)) {
    const child = path.split('/')[0]
    if (!def.elements.some((c) => c.id === child)) issues.push(`"${el.id}" overrides "${path}", which ${spec.name} doesn't contain`)
  }
  return issues
}

/** The board's own template spec, and every embedded definition. */
function checkTemplates(board: Board, withDefinitions: boolean): string[] {
  const issues: string[] = []
  if (board.template) {
    const ids = new Set(board.elements.map((e) => e.id))
    for (const port of board.template.ports) {
      if (!ids.has(port.target)) issues.push(`port "${port.name}" points at unknown "${port.target}"`)
    }
    const names = board.template.params.map((p) => p.name)
    if (new Set(names).size !== names.length) issues.push('template parameters must have different names')
  }
  if (!withDefinitions) return issues
  for (const [key, def] of Object.entries(board.definitions)) {
    const cycle = definitionCycle(board, key)
    if (cycle) {
      issues.push(`template ${key} contains itself: ${cycle.join(' → ')}`)
      continue
    }
    // A definition is checked like a board, against the shared definitions.
    const own = checkBoard({ ...def, definitions: board.definitions }, { definitions: false })
    for (const issue of own) issues.push(`in template ${key}: ${issue}`)
  }
  return issues
}

/** Template definitions no instance needs any more; dropped so files carry only what they use. */
function unusedDefinitions(board: Board): string[] {
  const used = usedDefinitions(board)
  return Object.keys(board.definitions).filter((k) => !used.has(k))
}

/**
 * Applies a list of ops as one unit: cascades removals, then checks integrity.
 * Throws OpError (with every issue) and leaves the input board untouched on failure.
 */
export function commit(board: Board, ops: readonly Op[]): Applied {
  let current = board
  const applied: Op[] = []
  const inverse: Op[] = []
  // Ids removed by a cascade; removing them again later in the same commit is a no-op.
  const cascaded = new Set<Id>()
  const run = (op: Op, isCascade = false) => {
    if (op.op === 'remove') {
      if (cascaded.has(op.id) && indexOf(current, op.id) < 0) return
      if (isCascade) cascaded.add(op.id)
    }
    if (op.op === 'remove' && indexOf(current, op.id) >= 0) {
      // Recomputed after each step: an earlier cascade can change what the next one must do.
      for (let next = cascadeFor(current, op.id)[0]; next; next = cascadeFor(current, op.id)[0]) run(next, true)
    }
    const r = applyOp(current, op)
    current = r.board
    applied.push(op)
    inverse.unshift(r.inverse)
  }
  ops.forEach((op, i) => {
    try {
      run(op)
    } catch (e) {
      if (e instanceof OpError) throw new OpError(e.issues.map((m) => `op ${i + 1} (${op.op}): ${m}`))
      throw e
    }
  })
  if (applied.some((o) => o.op === 'remove' || o.op === 'replace' || o.op === 'update' || o.op === 'define')) {
    for (const key of unusedDefinitions(current)) run({ op: 'undefine', key })
  }
  const issues = checkBoard(current)
  if (issues.length) throw new OpError(issues)
  return { board: current, ops: applied, inverse }
}
