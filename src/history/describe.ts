import type { Op } from '../model/ops'
import type { Board, BoardElement } from '../model/types'

function nameOf(el: BoardElement | undefined, fallbackId: string): string {
  if (!el) return fallbackId
  const text = el.kind === 'node' ? el.label : el.kind === 'text' ? el.text : el.kind === 'edge' || el.kind === 'group' || el.kind === 'frame' ? el.label : undefined
  const clean = text?.replace(/\s+/g, ' ').trim()
  if (clean) return clean.length > 32 ? `“${clean.slice(0, 31)}…”` : `“${clean}”`
  const noun = { node: 'shape', edge: 'arrow', text: 'text', group: 'group', frame: 'frame', image: 'image', draw: 'drawing', instance: `${el.kind === 'instance' ? el.template.split('@')[0] : ''} copy` }[el.kind]
  return `${noun} ${el.id}`
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

const VERB_BY_FIELD: [string[], string][] = [
  [['at'], 'Moved'],
  [['size'], 'Resized'],
  [['at', 'size'], 'Resized'],
  [['label'], 'Renamed'],
  [['text'], 'Edited'],
  [['style'], 'Restyled'],
  [['members'], 'Regrouped'],
  [['path'], 'Redrew'],
  [['at', 'path'], 'Redrew'],
]

function updateVerb(ops: Extract<Op, { op: 'update' }>[]): string | undefined {
  const fields = new Set(ops.flatMap((o) => Object.keys(o.set)))
  fields.delete('hints')
  const key = [...fields].sort().join(',')
  return VERB_BY_FIELD.find(([f]) => [...f].sort().join(',') === key)?.[1]
}

/** A short title for the ops a change asked for (before cascades), written for the history panel. */
export function describeOps(before: Board, allOps: readonly Op[]): string {
  // A title or default-style change rides along with element changes without naming them.
  const elementOps = allOps.filter((o) => o.op !== 'board')
  if (allOps.length && elementOps.length === 0) return 'Changed board settings'
  const ops = elementOps
  const byId = new Map(before.elements.map((e) => [e.id, e]))
  const adds = ops.filter((o): o is Extract<Op, { op: 'add' }> => o.op === 'add')
  const removes = ops.filter((o): o is Extract<Op, { op: 'remove' }> => o.op === 'remove')
  const updates = ops.filter((o): o is Extract<Op, { op: 'update' }> => o.op === 'update')
  const others = ops.filter((o) => o.op === 'reorder' || o.op === 'replace')

  if (ops.length === 0) return 'No change'
  if (others.length === ops.length) {
    if (ops.every((o) => o.op === 'reorder')) return 'Changed stacking order'
  }
  if (adds.length && !removes.length && !updates.length && !others.length) {
    const groups = adds.filter((o) => o.element.kind === 'group')
    if (groups.length === adds.length) return `Grouped ${count(groups.reduce((n, g) => n + (g.element as { members: string[] }).members.length, 0), 'element')}`
    return adds.length === 1 ? `Added ${nameOf(adds[0].element, adds[0].element.id)}` : `Added ${count(adds.length, 'element')}`
  }
  if (removes.length && !adds.length && !others.length) {
    return removes.length === 1 ? `Deleted ${nameOf(byId.get(removes[0].id), removes[0].id)}` : `Deleted ${count(removes.length, 'element')}`
  }
  if (updates.length && !adds.length && !removes.length) {
    const verb = updateVerb(updates)
    const ids = [...new Set(updates.map((o) => o.id))]
    if (verb && ids.length === 1) return `${verb} ${nameOf(byId.get(ids[0]), ids[0])}`
    if (verb) return `${verb} ${count(ids.length, 'element')}`
    if (ids.length === 1) return `Changed ${nameOf(byId.get(ids[0]), ids[0])}`
  }
  const touched = new Set(ops.map((o) => ('id' in o ? o.id : 'element' in o ? o.element.id : '')))
  return `Changed ${count(touched.size, 'element')}`
}
