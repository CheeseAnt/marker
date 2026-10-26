import { MERGED_FIELDS, type Op } from './ops'
import type { Board, BoardElement, Id } from './types'

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

function patch(a: BoardElement, b: BoardElement): Record<string, unknown> {
  const set: Record<string, unknown> = {}
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (key === 'id' || key === 'kind' || equal(ra[key], rb[key])) continue
    if ((MERGED_FIELDS as readonly string[]).includes(key)) {
      const pa = (ra[key] ?? {}) as Record<string, unknown>
      const pb = (rb[key] ?? {}) as Record<string, unknown>
      const sub: Record<string, unknown> = {}
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if (!equal(pa[k], pb[k])) sub[k] = pb[k] ?? null
      }
      set[key] = sub
    } else {
      set[key] = rb[key] ?? null
    }
  }
  return set
}

/** Ops that turn board `a` into board `b` (used when the board text is edited directly). */
export function diffBoards(a: Board, b: Board): Op[] {
  const inA = new Map(a.elements.map((e) => [e.id, e]))
  const inB = new Map(b.elements.map((e) => [e.id, e]))
  const ops: Op[] = []

  const meta: { title?: string; defaults?: Board['defaults'] } = {}
  if (a.title !== b.title) meta.title = b.title
  if (!equal(a.defaults, b.defaults)) meta.defaults = b.defaults
  if (Object.keys(meta).length) ops.push({ op: 'board', set: meta })

  // Adds first and removes last, so references are valid whenever cascades run.
  const removes: Op[] = []
  for (const el of b.elements) {
    const old = inA.get(el.id)
    if (!old) ops.push({ op: 'add', element: el })
    else if (old.kind !== el.kind) ops.push({ op: 'replace', element: el })
    else {
      const set = patch(old, el)
      if (Object.keys(set).length) ops.push({ op: 'update', id: el.id, set })
    }
  }
  for (const el of a.elements) if (!inB.has(el.id)) removes.push({ op: 'remove', id: el.id })
  ops.push(...removes)

  // Order after the ops above: survivors keep their order and adds go on top.
  const order: Id[] = [
    ...a.elements.filter((e) => inB.has(e.id)).map((e) => e.id),
    ...b.elements.filter((e) => !inA.has(e.id)).map((e) => e.id),
  ]
  const desired = b.elements.map((e) => e.id)
  const keep = longestIncreasing(desired.map((id) => order.indexOf(id)))
  desired.forEach((id, i) => {
    if (!keep.has(i)) ops.push({ op: 'reorder', id, after: i > 0 ? desired[i - 1] : null })
  })
  return ops
}

/** Indices of one longest strictly increasing subsequence. */
export function longestIncreasing(xs: number[]): Set<number> {
  const tails: number[] = []
  const prev: number[] = new Array(xs.length).fill(-1)
  xs.forEach((x, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[tails[mid]] < x) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  })
  const out = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) out.add(i)
  return out
}
