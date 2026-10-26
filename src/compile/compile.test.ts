import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
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
      Object.assign(byId(s, 'api~label'), { text: 'Gateway', originalText: 'Gateway' })
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

describe('fonts', () => {
  const fonted = parseBoard(`board "f" v1
style default font=normal

node a "Default" rect at(0,0)
node b "Own font" rect at(0,200) font=display
text t "Code note" at(300,0) font=mono
edge e a -> b "labelled" font=virgil
`)
  const family = (els: ExElement[], id: string) => byId(els, id).fontFamily

  it('uses the board default unless an element sets its own', () => {
    const { elements } = compileBoard(fonted)
    expect(family(elements, 'a~label')).toBe(6)
    expect(family(elements, 'b~label')).toBe(7)
    expect(family(elements, 't')).toBe(3)
    expect(family(elements, 'e~label')).toBe(1)
  })

  it('records a font picked on the canvas on that element only', () => {
    for (const [familyNumber, font] of [[5, 'hand'], [1, 'virgil'], [9, 'sans'], [8, 'code']] as const) {
      for (const id of ['t', 'e']) {
        const target = id === 't' ? 't' : 'e~label'
        // Picking the font an element already has is not a change.
        if (byId(compileBoard(fonted).elements, target).fontFamily === familyNumber) continue
        const { ops, next, again } = editScene(fonted, (s) => {
          byId(s, target).fontFamily = familyNumber
        })
        expect(ops).toEqual([{ op: 'update', id, set: { style: { font } } }])
        expect(next.elements.find((e) => e.id === 'b')?.style.font).toBe('display')
        expect(again).toEqual([])
      }
    }
  })

  it('resizes an auto-sized node to fit its label in a new font', () => {
    const { ops, next } = editScene(fonted, (s) => {
      byId(s, 'a~label').fontFamily = 3
    })
    expect(ops).toEqual([{ op: 'update', id: 'a', set: { style: { font: 'mono' } } }])
    expect(byId(compileBoard(next).elements, 'a').width).not.toBe(byId(compileBoard(fonted).elements, 'a').width)
  })

  it('keeps fonts outside the presets as a hint', () => {
    const { ops, next } = editScene(fonted, (s) => {
      byId(s, 't').fontFamily = 2
    })
    expect(ops).toEqual([{ op: 'update', id: 't', set: { style: { font: 'hand' }, hints: { fontFamily: 2 } } }])
    expect(family(compileBoard(next).elements, 't')).toBe(2)
  })

  it('changing the board default restyles elements that follow it', () => {
    const next = commit(fonted, [{ op: 'board', set: { defaults: { font: 'virgil' } } }]).board
    expect(family(compileBoard(next).elements, 'a~label')).toBe(1)
    expect(family(compileBoard(next).elements, 'b~label')).toBe(7)
  })
})

describe('images', () => {
  const pics = parseBoard('board "p" v1\nimage i1 asset:abc at(0,0) size(300,150)\n')

  it('keeps crops and flips made on the canvas', () => {
    const { ops, next, again } = editScene(pics, (s) => {
      Object.assign(byId(s, 'i1'), { crop: { x: 10, y: 0, width: 200, height: 150, naturalWidth: 300, naturalHeight: 150 }, scale: [-1, 1] })
    })
    expect(ops).toEqual([{ op: 'update', id: 'i1', set: { hints: { crop: '10,0,200,150,300,150', flip: 'h' } } }])
    expect(byId(compileBoard(next).elements, 'i1')).toMatchObject({ crop: { x: 10, width: 200 }, scale: [-1, 1] })
    expect(again).toEqual([])
  })
})

describe('cylinders', () => {
  const cyl = parseBoard(`board "c" v1
node api "API" rect at(0,0) size(160,60)
node db "Orders" cylinder at(0,200) size(160,120) fill=#e3f2fd
edge e1 api -> db "reads"
group g1 [api, db]
`)

  it('round-trips through the text format', () => {
    expect(parseBoard(printBoard(cyl))).toEqual(cyl)
  })

  it('draws an outline and a rim, grouped under the node, with arrows and label on the node', () => {
    const scene = compileBoard(cyl).elements
    const node = byId(scene, 'db')
    const body = byId(scene, 'db~body')
    const rim = byId(scene, 'db~rim')
    expect(node).toMatchObject({ type: 'rectangle', strokeColor: 'transparent', backgroundColor: 'transparent', groupIds: ['db', 'g1'] })
    expect(body).toMatchObject({ type: 'line', backgroundColor: '#e3f2fd', groupIds: ['db', 'g1'] })
    expect(body.points!.at(0)).toEqual(body.points!.at(-1))
    expect(rim).toMatchObject({ type: 'ellipse', backgroundColor: 'transparent', x: 0, y: 200, width: 160 })
    expect(byId(scene, 'e1').endBinding?.elementId).toBe('db')
    expect(byId(scene, 'db~label')).toMatchObject({ containerId: 'db' })
    // The label's container is the band between the rims, and the label sits inside it.
    const label = byId(scene, 'db~label')
    expect(node.y).toBeGreaterThanOrEqual(rim.y + rim.height)
    expect(node.y + node.height).toBeLessThan(200 + 120)
    expect(label.y).toBeGreaterThanOrEqual(node.y)
    expect(label.y + label.height).toBeLessThanOrEqual(node.y + node.height)
  })

  it('records a resize of the whole cylinder from its outline', () => {
    const { ops, again } = editScene(cyl, (s) => {
      const body = byId(s, 'db~body')
      body.width = 200
      body.height = 150
    })
    expect(ops).toContainEqual({ op: 'update', id: 'db', set: { size: { w: 200, h: 150 } } })
    expect(again).toEqual([])
  })

  it('records a move of the whole cylinder and a recolour of its outline, and nothing else', () => {
    const { ops, next, again } = editScene(cyl, (s) => {
      for (const e of s) if (e.groupIds.includes('db')) e.x += 40
      byId(s, 'db~body').backgroundColor = '#ffc9c9'
    })
    expect(ops).toEqual([{ op: 'update', id: 'db', set: { at: { kind: 'at', x: 40, y: 200 }, style: { fill: '#ffc9c9' } } }])
    expect(next.elements.find((e) => e.id === 'g1')).toMatchObject({ members: ['api', 'db'] })
    expect(again).toEqual([])
  })

  it('removes the node when its parts are deleted', () => {
    const { ops } = editScene(cyl, (s) => {
      for (const e of s) if (e.groupIds.includes('db')) e.isDeleted = true
    })
    expect(ops).toContainEqual({ op: 'remove', id: 'db' })
  })
})

describe('frames', () => {
  const framed = parseBoard(`board "f" v1
node api "API" rect at(0,0) size(160,60)
node db "Orders" cylinder at(0,200) size(160,120)
text t1 "outside" at(400,0)
frame f1 "Backend" [api, db]
`)

  it('round-trips through the text format, with and without a box', () => {
    expect(parseBoard(printBoard(framed))).toEqual(framed)
    const boxed = parseBoard('board "f" v1\nnode a "A" rect at(0,0)\nframe f "Area" [a] at(-50,-50) size(400,300)\n')
    expect(printBoard(boxed)).toContain('frame f "Area" [a] at(-50,-50) size(400,300)')
    expect(() => parseBoard('board "f" v1\nframe f "Area" [] at(0,0)\n')).toThrow(/both at\(x,y\) and size\(w,h\)/)
  })

  it('wraps its members, comes first, and its members and their parts point at it', () => {
    const scene = compileBoard(framed).elements
    expect(scene[0]).toMatchObject({ id: 'f1', type: 'frame', name: 'Backend', x: -40, y: -40, width: 240, height: 400 })
    for (const id of ['api', 'api~label', 'db', 'db~body', 'db~rim', 'db~label']) expect(byId(scene, id).frameId).toBe('f1')
    expect(byId(scene, 't1').frameId).toBeNull()
  })

  it('records what is dropped into or out of a frame, and a frame moved by hand', () => {
    const { ops, again } = editScene(framed, (s) => {
      byId(s, 't1').frameId = 'f1'
      byId(s, 'api').frameId = null
      byId(s, 'api~label').frameId = null
      const f = byId(s, 'f1')
      f.x += 10
    })
    expect(ops).toContainEqual({ op: 'update', id: 'f1', set: { at: { x: -30, y: -40 }, size: { w: 240, h: 400 } } })
    expect(ops).toContainEqual({ op: 'update', id: 'f1', set: { members: ['db', 't1'] } })
    expect(again).toEqual([])
  })

  it('adopts a frame drawn by hand around existing elements', () => {
    const { ops, next } = editScene(framed, (s) => {
      byId(s, 't1').frameId = 'Fr9'
      return [drawn({ id: 'Fr9', type: 'frame', x: 380, y: -20, width: 200, height: 100, name: 'Notes' }), ...s]
    })
    expect(ops[0]).toEqual({ op: 'add', element: expect.objectContaining({ kind: 'frame', id: 'Fr9', label: 'Notes', members: ['t1'], at: { x: 380, y: -20 } }) })
    expect(next.elements.find((e) => e.id === 'Fr9')).toMatchObject({ members: ['t1'] })
  })

  it('drops a removed member and refuses frames in frames', () => {
    const removed = commit(framed, [{ op: 'remove', id: 'api' }]).board
    expect(removed.elements.find((e) => e.id === 'f1')).toMatchObject({ members: ['db'] })
    expect(() => commit(framed, [{ op: 'add', element: { kind: 'frame', id: 'f2', label: '', members: ['f1'], style: {}, hints: {} } }])).toThrow()
  })
})

describe('labels that wrap', () => {
  const long = parseBoard(`board "w" v1
node r "Customer orders and payments archive" rect at(0,0) size(160,100)
node c "Customer orders and payments archive" cylinder at(300,0) size(160,160)
node e "Customer orders and payments archive" ellipse at(600,0) size(160,100)
`)

  it('wraps inside rectangles and a cylinder’s middle, and keeps what was typed as the label', () => {
    const scene = compileBoard(long).elements
    for (const id of ['r', 'c']) {
      const label = byId(scene, `${id}~label`)
      expect(label.text).toContain('\n')
      expect(label.originalText).toBe('Customer orders and payments archive')
      expect(label.width).toBeLessThanOrEqual(byId(scene, id).width)
    }
    expect(byId(scene, 'e~label').text).not.toContain('\n')
    // Excalidraw wrapping a label differently is not an edit.
    const { ops } = editScene(long, (s) => {
      byId(s, 'r~label').text = 'Customer orders\nand payments\narchive'
    })
    expect(ops).toEqual([])
  })

  it('makes a node with a very long label taller instead of wider than the maximum', () => {
    const board = parseBoard(`board "w" v1\nnode r "${'word '.repeat(40).trim()}" rect at(0,0)\n`)
    const box = compileBoard(board).boxes.get('r')!
    expect(box.w).toBeLessThanOrEqual(480)
    expect(box.h).toBeGreaterThan(100)
  })
})
