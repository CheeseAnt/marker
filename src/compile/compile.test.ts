import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { commit } from '../model/apply'
import { boardArb } from '../model/arbitrary'
import type { Board } from '../model/types'
import type { ExElement } from './exTypes'
import { diffScene } from './fromExcalidraw'
import { compileBoard, seedFor } from './toExcalidraw'

const board = parseBoard(`board "t" v1
node api "API" rect at(0,0) size(160,60) fill=#e3f2fd
node db "DB" ellipse below(api,80)
node q "" diamond at(400,0)
edge e1 api -> db "reads"
edge e2 q -- (600,300)
text t1 "note" at(0,-100)
draw d1 at(500,500) path="M0 0 L10 10 L20 0"
group g1 [api, db]
`)

type Scene = ExElement[]
const clone = (s: Scene): Scene => structuredClone(s)
const byId = (s: Scene, id: string) => s.find((e) => e.id === id)!

function editScene(b: Board, edit: (s: Scene) => Scene | void) {
  const compiled = compileBoard(b)
  const scene = clone(compiled.elements)
  const edited = edit(scene) ?? scene
  const ops = diffScene({ board: b, compiled, scene: edited })
  const next = commit(b, ops).board
  // Applying the ops must account for the whole edit.
  const again = diffScene({ board: next, compiled: compileBoard(next), scene: edited })
  return { ops, next, again }
}

/** A minimal hand-drawn Excalidraw element. */
function drawn(partial: Partial<ExElement> & Pick<ExElement, 'id' | 'type'>): ExElement {
  return {
    x: 0, y: 0, width: 100, height: 50, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: null,
    seed: 42, version: 1, versionNonce: 1, index: null, isDeleted: false, groupIds: [], frameId: null,
    boundElements: null, updated: 1, link: null, locked: false,
    ...partial,
  }
}

describe('compileBoard', () => {
  const { elements } = compileBoard(board)

  it('emits stable ids, labels and seeds', () => {
    expect(elements.map((e) => e.id)).toEqual(['api', 'api~label', 'db', 'db~label', 'q', 'e1', 'e1~label', 'e2', 't1', 'd1'])
    expect(byId(elements, 'api').seed).toBe(seedFor('api'))
    expect(byId(elements, 'api~label')).toMatchObject({ containerId: 'api', text: 'API', textAlign: 'center' })
    expect(compileBoard(board).elements).toEqual(elements)
  })

  it('resolves relative placement and binds arrows', () => {
    const api = byId(elements, 'api')
    const db = byId(elements, 'db')
    expect(db.y).toBe(api.y + api.height + 80)
    expect(db.x + db.width / 2).toBeCloseTo(api.x + api.width / 2)
    const e1 = byId(elements, 'e1')
    expect(e1.startBinding?.elementId).toBe('api')
    expect(e1.endBinding?.elementId).toBe('db')
    expect(e1.endArrowhead).toBe('arrow')
    // Starts just below api and ends just above db.
    expect(e1.y).toBeGreaterThan(api.y + api.height)
    expect(e1.y + e1.points!.at(-1)![1]).toBeLessThan(db.y)
    expect(api.boundElements).toEqual([{ id: 'api~label', type: 'text' }, { id: 'e1', type: 'arrow' }])
    expect(byId(elements, 'e2')).toMatchObject({ endBinding: null, startArrowhead: null, endArrowhead: null })
  })

  it('maps groups to groupIds on members and their labels', () => {
    expect(byId(elements, 'api').groupIds).toEqual(['g1'])
    expect(byId(elements, 'api~label').groupIds).toEqual(['g1'])
    expect(byId(elements, 'q').groupIds).toEqual([])
  })
})

describe('diffScene', () => {
  it('finds nothing to do in a freshly compiled scene', () => {
    fc.assert(
      fc.property(boardArb, (b) => {
        const compiled = compileBoard(b)
        expect(diffScene({ board: b, compiled, scene: clone(compiled.elements) })).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('pins a moved relative node to its new position', () => {
    const { ops, again } = editScene(board, (s) => {
      byId(s, 'db').x += 50
    })
    expect(ops).toEqual([{ op: 'update', id: 'db', set: { at: { kind: 'at', x: byId(compileBoard(board).elements, 'db').x + 50, y: 140 } } }])
    expect(again).toEqual([])
  })

  it('picks up restyles, resizes and label edits', () => {
    const { ops, again } = editScene(board, (s) => {
      Object.assign(byId(s, 'api'), { strokeColor: '#c00', roundness: null })
      byId(s, 'api~label').text = 'Gateway'
      byId(s, 'api~label').fontSize = 28
      byId(s, 'q').width = 300
    })
    expect(ops).toEqual([
      { op: 'update', id: 'api', set: { label: 'Gateway', style: { stroke: '#c00', fontSize: 28 }, hints: { roundness: 'sharp' } } },
      { op: 'update', id: 'q', set: { size: { w: 300, h: byId(compileBoard(board).elements, 'q').height } } },
    ])
    expect(again).toEqual([])
  })

  it('moves relative dependents with their anchor, and pins a resized dependent', () => {
    const before = byId(compileBoard(board).elements, 'db')
    const anchor = editScene(board, (s) => {
      byId(s, 'api').width = 260
    })
    expect(anchor.ops).toEqual([{ op: 'update', id: 'api', set: { size: { w: 260, h: 60 } } }])
    expect(byId(compileBoard(anchor.next).elements, 'db').x).toBe(before.x + 50)

    const dependent = editScene(board, (s) => {
      byId(s, 'db').width += 40
    })
    expect(dependent.ops).toEqual([
      { op: 'update', id: 'db', set: { size: { w: before.width + 40, h: before.height }, at: { kind: 'at', x: before.x, y: before.y } } },
    ])
    expect(dependent.again).toEqual([])
  })

  it('removes a deleted node and keeps its unbound arrow as a free end', () => {
    const { ops, next, again } = editScene(board, (s) => {
      byId(s, 'db').isDeleted = true
      byId(s, 'db~label').isDeleted = true
      byId(s, 'e1').endBinding = null
    })
    expect(ops.map((o) => o.op)).toEqual(['update', 'update', 'remove'])
    expect(next.elements.find((e) => e.id === 'e1')).toMatchObject({ to: { point: expect.any(Object) } })
    expect(next.elements.find((e) => e.id === 'g1')).toMatchObject({ members: ['api'] })
    expect(again).toEqual([])
  })

  it('adopts hand-drawn shapes, labels and arrows', () => {
    const { ops, next, again } = editScene(board, (s) => [
      ...s,
      drawn({ id: 'Rk3', type: 'rectangle', x: 800, y: 0, backgroundColor: '#ffc9c9', boundElements: [{ id: 'T9', type: 'text' }] }),
      drawn({ id: 'T9', type: 'text', text: 'Cache', originalText: 'Cache', containerId: 'Rk3', fontSize: 20, fontFamily: 5 }),
      drawn({
        id: '-arrow',
        type: 'arrow',
        x: 900,
        y: 60,
        points: [[0, 0], [0, 100]],
        startBinding: { elementId: 'Rk3', focus: 0, gap: 4 },
        endBinding: { elementId: 'q', focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: 'triangle',
      }),
    ])
    expect(ops).toEqual([
      {
        op: 'add',
        element: expect.objectContaining({ kind: 'node', id: 'Rk3', label: 'Cache', shape: 'rect', style: { fill: '#ffc9c9' }, hints: { seed: 42, roundness: 'sharp' } }),
      },
      {
        op: 'add',
        element: expect.objectContaining({ kind: 'edge', id: 'x-arrow', from: { id: 'Rk3' }, to: { id: 'q' }, head: '->', hints: { seed: 42, endHead: 'triangle', roundness: 'sharp' } }),
      },
    ])
    expect(compileBoard(next).elements.find((e) => e.id === 'x-arrow')?.endArrowhead).toBe('triangle')
    // The arrow was re-keyed (ids may not start with "-"), which the app fixes by re-rendering the scene.
    const touchesArrow = (o: (typeof again)[number]) => ('element' in o ? o.element.id : 'id' in o ? o.id : '').startsWith('x-arrow')
    expect(again.filter((o) => !touchesArrow(o))).toEqual([])
  })

  it('reads new, changed and removed groups', () => {
    const { ops, again } = editScene(board, (s) => {
      for (const id of ['api', 'api~label', 'db', 'db~label']) byId(s, id).groupIds = []
      for (const id of ['q', 't1']) byId(s, id).groupIds = ['G2']
    })
    expect(ops).toEqual([
      { op: 'remove', id: 'g1' },
      { op: 'add', element: { kind: 'group', id: 'G2', members: ['q', 't1'], style: {}, hints: {} } },
    ])
    expect(again).toEqual([])
  })

  it('reorders with the fewest moves', () => {
    const { ops, again } = editScene(board, (s) => {
      const t1 = s.findIndex((e) => e.id === 't1')
      const [moved] = s.splice(t1, 1)
      s.unshift(moved)
    })
    expect(ops).toEqual([{ op: 'reorder', id: 't1', after: null }])
    expect(again).toEqual([])
  })

  it('reshapes and moves freehand drawings', () => {
    const { ops, again } = editScene(board, (s) => {
      const d = byId(s, 'd1')
      d.x += 10
      d.points = [[0, 0], [30, 30]]
    })
    expect(ops).toEqual([{ op: 'update', id: 'd1', set: { at: { x: 510, y: 500 }, path: 'M0 0 L30 30' } }])
    expect(again).toEqual([])
  })
})
