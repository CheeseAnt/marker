import { instanceLayout, resolveBoxes, type Box } from '../model/geometry'
import type { Op } from '../model/ops'
import { parsePath, pointsToPath } from '../model/path'
import type { Board, BoardElement, Endpoint, Id, InstanceElement, Point } from '../model/types'

export interface DetachOptions {
  /** Keep the parts together in a group that takes over the copy's id (otherwise they stand alone). */
  keepGrouped: boolean
}

/**
 * Ops that replace a template copy with ordinary elements in the same places: params and
 * overrides are baked in, nested copies stay copies, and edges to its ports move to the
 * elements those ports were on.
 */
export function detachOps(board: Board, instanceId: Id, opts: DetachOptions): Op[] {
  const inst = board.elements.find((e): e is InstanceElement => e.id === instanceId && e.kind === 'instance')
  if (!inst) return []
  const layout = instanceLayout(board, inst)
  const box = resolveBoxes(board).get(inst.id)
  if (!layout || !box) return []
  const { content, bounds, scale } = layout
  const inner = resolveBoxes(content)

  const taken = new Set(board.elements.map((e) => e.id))
  const ids = new Map<Id, Id>()
  for (const el of content.elements) {
    let id = `${inst.id}_${el.id}`
    while (taken.has(id)) id += '_'
    taken.add(id)
    ids.set(el.id, id)
  }
  const map = (id: Id) => ids.get(id) ?? id
  const pt = (p: Point): Point => ({ x: round(box.x + (p.x - bounds.x) * scale), y: round(box.y + (p.y - bounds.y) * scale) })
  const pinned = (id: Id) => {
    const b: Box | undefined = inner.get(id)
    return b ? { kind: 'at' as const, ...pt(b) } : undefined
  }
  const scaled = <T extends { style: BoardElement['style'] }>(el: T): T =>
    scale === 1 ? el : { ...el, style: { ...el.style, fontSize: round((el.style.fontSize ?? content.defaults.fontSize ?? 20) * scale) } }

  const added: BoardElement[] = content.elements.map((el): BoardElement => {
    const id = map(el.id)
    switch (el.kind) {
      case 'node': {
        const size = el.size ?? inner.get(el.id)
        return scaled({ ...el, id, at: pinned(el.id), ...(size && { size: { w: round(size.w * scale), h: round(size.h * scale) } }) })
      }
      case 'text':
        return scaled({ ...el, id, at: pinned(el.id) })
      case 'image':
        return { ...el, id, at: pinned(el.id) ?? el.at, size: { w: round(el.size.w * scale), h: round(el.size.h * scale) } }
      case 'instance':
        return { ...el, id, at: pinned(el.id), scale: round((el.scale ?? 1) * scale) }
      case 'draw': {
        const points = parsePath(el.path).points.map((p) => ({ x: p.x * scale, y: p.y * scale }))
        return { ...el, id, at: pt(el.at), path: pointsToPath(points) }
      }
      case 'edge': {
        const end = (e: Endpoint): Endpoint => ('point' in e ? { point: pt(e.point) } : { ...e, id: map(e.id) })
        return scaled({ ...el, id, from: end(el.from), to: end(el.to), ...(el.via && { via: el.via.map(pt) }) })
      }
      case 'group':
        return { ...el, id, members: el.members.map(map) }
      case 'frame':
        return {
          ...el,
          id,
          members: el.members.map(map),
          ...(el.at && { at: pt(el.at) }),
          ...(el.size && { size: { w: round(el.size.w * scale), h: round(el.size.h * scale) } }),
        }
    }
  })

  // Board defaults may differ from the template's, so its defaults move onto each part.
  const withDefaults = added.map((el) => ({ ...el, style: { ...content.defaults, ...el.style } }))

  const ops: Op[] = withDefaults.map((element) => ({ op: 'add', element }) as Op)
  const ports = new Map(board.definitions[inst.template]?.template?.ports.map((p) => [p.name, p.target]))
  for (const el of board.elements) {
    if (el.kind !== 'edge') continue
    const retarget = (e: Endpoint): Endpoint | undefined => {
      if (!('id' in e) || e.id !== inst.id) return undefined
      const target = e.port ? ports.get(e.port) : undefined
      // An edge to the copy itself goes to its first top-level part.
      return { id: map(target ?? content.elements.find((c) => c.kind !== 'edge' && c.kind !== 'group' && c.kind !== 'frame')?.id ?? inst.id) }
    }
    const from = retarget(el.from)
    const to = retarget(el.to)
    if (from || to) ops.push({ op: 'update', id: el.id, set: { ...(from && { from }), ...(to && { to }) } })
  }
  ops.push({ op: 'remove', id: inst.id })
  if (opts.keepGrouped) {
    const nested = new Set(content.elements.flatMap((e) => (e.kind === 'group' ? e.members : [])))
    const members = content.elements.filter((e) => !nested.has(e.id) && e.kind !== 'frame').map((e) => map(e.id))
    ops.push({ op: 'add', element: { kind: 'group', id: inst.id, members, style: {}, hints: {} } })
  }
  return ops
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
