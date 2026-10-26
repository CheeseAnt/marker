import { resolveBoxes } from './geometry'
import { FIXED_FIELDS, MERGED_FIELDS, type Op } from './ops'
import { elementSchema, type Board, type BoardElement, type Id } from './types'

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
export function checkBoard(board: Board): string[] {
  const issues: string[] = []
  const byId = new Map<Id, BoardElement>()
  for (const el of board.elements) {
    if (byId.has(el.id)) issues.push(`duplicate id "${el.id}"`)
    byId.set(el.id, el)
  }
  const isAnchor = (el: BoardElement | undefined) =>
    !!el && (el.kind === 'node' || el.kind === 'text' || el.kind === 'image' || el.kind === 'draw')

  const parentOf = new Map<Id, Id>()
  for (const el of board.elements) {
    if (el.kind === 'edge') {
      for (const [side, end] of [['from', el.from], ['to', el.to]] as const) {
        if ('id' in end && !isAnchor(byId.get(end.id))) {
          issues.push(`edge "${el.id}" ${side} "${end.id}" is not a node, text, image or drawing`)
        }
      }
    }
    if ((el.kind === 'node' || el.kind === 'text' || el.kind === 'image') && el.at?.kind === 'rel') {
      if (!isAnchor(byId.get(el.at.of))) issues.push(`"${el.id}" is placed ${el.at.dir} unknown "${el.at.of}"`)
    }
    if (el.kind === 'group') {
      for (const m of el.members) {
        const member = byId.get(m)
        if (!member) issues.push(`group "${el.id}" has unknown member "${m}"`)
        if (parentOf.has(m)) issues.push(`"${m}" is in both groups "${parentOf.get(m)}" and "${el.id}"`)
        parentOf.set(m, el.id)
      }
    }
  }

  // Cycles in relative placement or group nesting.
  const anchorOf = (id: Id): Id | undefined => {
    const el = byId.get(id)
    return el && (el.kind === 'node' || el.kind === 'text' || el.kind === 'image') && el.at?.kind === 'rel'
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
  return issues
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
  const issues = checkBoard(current)
  if (issues.length) throw new OpError(issues)
  return { board: current, ops: applied, inverse }
}
