import type { Board, BoardElement, EdgeElement } from '../src/model/types'

/** A check returns a failure message, or nothing when it passes. */
export type Check = (after: Board, before: Board) => string | undefined

const textOf = (e: BoardElement) => (e.kind === 'node' || e.kind === 'edge' ? e.label : e.kind === 'text' ? e.text : undefined) ?? ''

export function findLabelled(board: Board, label: RegExp, kind?: BoardElement['kind']): BoardElement[] {
  return board.elements.filter((e) => (!kind || e.kind === kind) && label.test(textOf(e)))
}

function edgesBetween(board: Board, a: string, b: string): EdgeElement[] {
  return board.elements.filter(
    (e): e is EdgeElement =>
      e.kind === 'edge' &&
      'id' in e.from &&
      'id' in e.to &&
      ((e.from.id === a && e.to.id === b) || (e.from.id === b && e.to.id === a)),
  )
}

export const has = (label: RegExp, kind: BoardElement['kind'] = 'node'): Check => (after) =>
  findLabelled(after, label, kind).length ? undefined : `no ${kind} labelled ${label}`

export const hasNone = (label: RegExp): Check => (after) => (findLabelled(after, label).length ? `still has something labelled ${label}` : undefined)

export const count = (kind: BoardElement['kind'], n: number | ((before: number) => number)): Check => (after, before) => {
  const want = typeof n === 'number' ? n : n(before.elements.filter((e) => e.kind === kind).length)
  const got = after.elements.filter((e) => e.kind === kind).length
  return got === want ? undefined : `expected ${want} ${kind}s, found ${got}`
}

/** An edge joins elements labelled `a` and `b` (or with those ids), in either direction. */
export const connected = (a: RegExp | string, b: RegExp | string): Check => (after) => {
  const ids = (x: RegExp | string) => (typeof x === 'string' ? [x] : findLabelled(after, x).map((e) => e.id))
  for (const ia of ids(a)) for (const ib of ids(b)) if (edgesBetween(after, ia, ib).length) return undefined
  return `nothing connects ${a} and ${b}`
}

export const style = (id: string | RegExp, key: string, value: RegExp | ((v: unknown) => boolean)): Check => (after) => {
  const els = typeof id === 'string' ? after.elements.filter((e) => e.id === id) : findLabelled(after, id)
  if (!els.length) return `no element ${id}`
  const ok = (v: unknown) => (value instanceof RegExp ? value.test(String(v ?? '')) : value(v))
  return els.every((e) => ok({ ...after.defaults, ...e.style }[key as keyof BoardElement['style']])) ? undefined : `${id} ${key} doesn't match`
}

export const unchanged = (id: string): Check => (after, before) => {
  const a = JSON.stringify(before.elements.find((e) => e.id === id))
  const b = JSON.stringify(after.elements.find((e) => e.id === id))
  return a === b ? undefined : `${id} changed but shouldn't have`
}

export const removed = (id: string): Check => (after) => (after.elements.some((e) => e.id === id) ? `${id} is still there` : undefined)

/** The element labelled `label` sits to `side` of the one with `anchor` id (by resolved boxes). */
export const placed = (label: RegExp, side: 'below' | 'above' | 'left' | 'right', anchor: string, boxes: (b: Board) => Map<string, { x: number; y: number; w: number; h: number }>): Check => (after) => {
  const el = findLabelled(after, label)[0]
  const map = boxes(after)
  const a = map.get(anchor)
  const b = el && map.get(el.id)
  if (!a || !b) return `can't find ${label} or ${anchor}`
  const ok = { below: b.y >= a.y + a.h - 1, above: b.y + b.h <= a.y + 1, right: b.x >= a.x + a.w - 1, left: b.x + b.w <= a.x + 1 }[side]
  return ok ? undefined : `${label} isn't ${side} ${anchor}`
}

export const boardFont = (font: string): Check => (after) => (after.defaults.font === font ? undefined : `board font is ${after.defaults.font ?? 'hand'}, not ${font}`)

export const instances = (template: string, n: number): Check => (after) => {
  const got = after.elements.filter((e) => e.kind === 'instance' && e.template.startsWith(`${template}@`)).length
  return got === n ? undefined : `expected ${n} copies of ${template}, found ${got}`
}

export const edgeLabel = (id: string, label: RegExp): Check => (after) => {
  const e = after.elements.find((x) => x.id === id)
  return e?.kind === 'edge' && label.test(e.label ?? '') ? undefined : `${id} isn't labelled ${label}`
}

/** The edge now points the other way: its ends swapped, or its head flipped. */
export const reversed = (id: string, newFrom: string): Check => (after) => {
  const e = after.elements.find((x) => x.id === id)
  if (e?.kind !== 'edge') return `${id} is gone`
  const swapped = 'id' in e.from && e.from.id === newFrom && e.head === '->'
  return swapped || e.head === '<-' ? undefined : `${id} still points the same way`
}
