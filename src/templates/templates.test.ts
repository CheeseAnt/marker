import { describe, expect, it } from 'vitest'
import type { ExElement } from '../compile/exTypes'
import { diffSceneDetailed } from '../compile/fromExcalidraw'
import { compileBoard, seedFor } from '../compile/toExcalidraw'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import { checkBoard, commit } from '../model/apply'
import { detachOps } from './detach'

const BOARD = `board "Racks" v1

node lb "Load balancer" rect at(0,0) size(200,60)
use web1 server@2 at(0,150) with(name="Web 1")
use web2 server@2 right(web1,60) scale(1.5) with(name="Web 2") override(box.text="Edge box", box.fill=#ffc9c9)
edge e1 lb -> web1.in
edge e2 lb -> web2

define disk@1 {
  board "Disk" v1
  template disk "A disk"

  node d "SSD" ellipse at(0,0) size(80,40)
}

define server@2 {
  board "Server" v1
  template server "A web server with a disk"
  param name "Server"
  port in box top
  port out box bottom

  node box "{name}" rect at(0,0) size(160,80)
  use disk1 disk@1 below(box,20)
  text note "runs {name}" at(170,0)
}
`

const board = parseBoard(BOARD)
const byId = (els: ExElement[], id: string) => {
  const found = els.find((e) => e.id === id)
  if (!found) throw new Error(`no ${id} in ${els.map((e) => e.id).join(', ')}`)
  return found
}

describe('template text format', () => {
  it('parses definitions, params, ports and copies, and prints them back unchanged', () => {
    expect(board.definitions['server@2'].template).toEqual({
      name: 'server',
      description: 'A web server with a disk',
      params: [{ name: 'name', default: 'Server' }],
      ports: [
        { name: 'in', target: 'box', side: 'top' },
        { name: 'out', target: 'box', side: 'bottom' },
      ],
    })
    expect(board.elements.find((e) => e.id === 'web2')).toMatchObject({
      kind: 'instance',
      template: 'server@2',
      scale: 1.5,
      params: { name: 'Web 2' },
      overrides: { box: { text: 'Edge box', style: { fill: '#ffc9c9' } } },
    })
    expect(printBoard(board).split('\n')).toEqual(BOARD.split('\n'))
    expect(checkBoard(board)).toEqual([])
  })

  it.each([
    ['define a@1 {\n  board "A" v1\n  node x "" rect\n}', /needs a "template" line/],
    ['define a@1 {\n  board "A" v1\n  template b\n}', /holds template "b"/],
    ['define a@1 {\n  board "A" v1\n  template a\n', /missing its closing/],
    ['use x server', /expected a template like server@1/],
    ['use x s@1 override(box=#fff)', /expected child.field/],
  ])('rejects %j', (src, message) => {
    expect(() => parseBoard(`board "t" v1\n${src}`)).toThrow(message)
  })
})

describe('template checks', () => {
  it('reports unknown templates, params, ports and override targets', () => {
    const bad = parseBoard(BOARD.replace('with(name="Web 1")', 'with(nmae="Web 1")').replace('lb -> web1.in', 'lb -> web1.side').replace('box.fill=', 'bx.fill='))
    expect(checkBoard(bad)).toEqual(
      expect.arrayContaining([
        '"web1": server has no parameter "nmae" (it has name)',
        'edge "e1" to: server has no port "side" (it has in, out)',
        '"web2" overrides "bx", which server doesn\'t contain',
      ]),
    )
  })

  it('catches templates that contain themselves', () => {
    const loop = parseBoard(`board "t" v1
use a1 a@1 at(0,0)
define a@1 {
  board "A" v1
  template a
  use b1 b@1 at(0,0)
}
define b@1 {
  board "B" v1
  template b
  use a1 a@1 at(0,0)
}`)
    expect(checkBoard(loop)).toContain('template a@1 contains itself: a@1 → b@1 → a@1')
  })

  it('drops definitions nobody uses any more, and undo brings them back', () => {
    const r = commit(board, [
      { op: 'remove', id: 'web1' },
      { op: 'remove', id: 'web2' },
    ])
    expect(Object.keys(r.board.definitions)).toEqual([])
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })
})

describe('compiling copies', () => {
  const { elements, boxes } = compileBoard(board)

  it('fills params, applies overrides and namespaces nested parts', () => {
    expect(byId(elements, 'web1/box~label').text).toBe('Web 1')
    expect(byId(elements, 'web1/note').text).toBe('runs Web 1')
    expect(byId(elements, 'web2/box~label').text).toBe('Edge box')
    expect(byId(elements, 'web2/box').backgroundColor).toBe('#ffc9c9')
    expect(byId(elements, 'web1/disk1/d')).toMatchObject({ type: 'ellipse', groupIds: ['web1/disk1', 'web1'] })
  })

  it('places, scales and groups each copy, with its own wobble', () => {
    const box1 = byId(elements, 'web1/box')
    const box2 = byId(elements, 'web2/box')
    expect(box1).toMatchObject({ x: 0, y: 150, width: 160, height: 80, groupIds: ['web1'] })
    expect(box2).toMatchObject({ width: 240, height: 120 })
    expect(box2.x).toBe(boxes.get('web1')!.x + boxes.get('web1')!.w + 60)
    expect(byId(elements, 'web2/box~label').fontSize).toBe(30)
    expect(box1.seed).toBe(seedFor('web1/box'))
    expect(box1.seed).not.toBe(box2.seed)
  })

  it('binds edges to ports, and meets portless copies at their outline', () => {
    const e1 = byId(elements, 'e1')
    expect(e1.endBinding?.elementId).toBe('web1/box')
    expect(byId(elements, 'web1/box').boundElements).toContainEqual({ id: 'e1', type: 'arrow' })
    expect(byId(elements, 'e2').endBinding).toBeNull()
  })

  it('shows a placeholder for a missing template', () => {
    const missing = { ...board, definitions: {} }
    expect(compileBoard(missing).elements.find((e) => e.id === 'web1/missing~label')?.text).toBe('Missing template server@2')
  })
})

describe('editing copies on the canvas', () => {
  const compiled = compileBoard(board)
  const edit = (change: (s: ExElement[]) => ExElement[] | void) => {
    const scene = structuredClone(compiled.elements)
    const result = diffSceneDetailed({ board, compiled, scene: change(scene) ?? scene })
    return result
  }
  const parts = (s: ExElement[], id: string) => s.filter((e) => e.id.startsWith(`${id}/`))

  it('moves a whole copy', () => {
    const { ops, rejected } = edit((s) => parts(s, 'web1').forEach((e) => (e.x += 40)))
    expect(rejected).toEqual([])
    expect(ops).toEqual([{ op: 'update', id: 'web1', set: { at: { kind: 'at', x: 40, y: 150 } } }])
  })

  it('scales a whole copy', () => {
    const before = compiled.boxes.get('web1')!
    const { ops } = edit((s) =>
      parts(s, 'web1').forEach((e) => {
        e.x = before.x + (e.x - before.x) * 2
        e.y = before.y + (e.y - before.y) * 2
        e.width *= 2
        e.height *= 2
      }),
    )
    expect(ops).toEqual([{ op: 'update', id: 'web1', set: { scale: 2, at: { kind: 'at', x: 0, y: 150 } } }])
  })

  it('keeps text and style edits on parts as overrides, including nested parts', () => {
    const { ops } = edit((s) => {
      byId(s, 'web1/box~label').text = 'Primary'
      byId(s, 'web1/disk1/d').strokeColor = '#e03131'
    })
    expect(ops).toEqual([
      {
        op: 'update',
        id: 'web1',
        set: { overrides: { box: { text: 'Primary' }, 'disk1/d': { style: { stroke: '#e03131' } } } },
      },
    ])
    const next = commit(board, ops).board
    expect(byId(compileBoard(next).elements, 'web1/disk1/d').strokeColor).toBe('#e03131')
    expect(diffSceneDetailed({ board: next, compiled: compileBoard(next), scene: compileBoard(next).elements }).ops).toEqual([])
  })

  it('rejects moving a single part, and removes a fully deleted copy', () => {
    expect(edit((s) => void (byId(s, 'web1/note').x += 50)).rejected).toEqual(['web1'])
    const { ops } = edit((s) => parts(s, 'web2').forEach((e) => (e.isDeleted = true)))
    expect(ops).toEqual([{ op: 'remove', id: 'web2' }])
  })

  it('detaches a copy when it is ungrouped', () => {
    const { ops } = edit((s) => parts(s, 'web1').forEach((e) => (e.groupIds = e.groupIds.filter((g) => g !== 'web1'))))
    const next = commit(board, ops).board
    expect(next.elements.some((e) => e.id === 'web1')).toBe(false)
    expect(next.elements.find((e) => e.id === 'web1_box')).toMatchObject({ kind: 'node', label: 'Web 1', at: { kind: 'at', x: 0, y: 150 } })
    // The nested copy stays a copy; the edge to the port now points at the box it was on.
    expect(next.elements.find((e) => e.id === 'web1_disk1')).toMatchObject({ kind: 'instance', template: 'disk@1' })
    expect(next.elements.find((e) => e.id === 'e1')).toMatchObject({ to: { id: 'web1_box' } })
  })
})

describe('detachOps', () => {
  it('keeps every part where it was, at the copy\'s scale', () => {
    const r = commit(board, detachOps(board, 'web2', { keepGrouped: true }))
    const before = compileBoard(board).elements
    const after = compileBoard(r.board).elements
    for (const part of ['box', 'note']) {
      const a = byId(before, `web2/${part}`)
      const b = byId(after, `web2_${part}`)
      // Text width is re-measured by Excalidraw, so only shapes are compared by size.
      const dims = (e: ExElement) => (e.type === 'text' ? [e.x, e.y] : [e.x, e.y, e.width, e.height])
      expect(dims(b)).toEqual(dims(a).map((n) => Math.round(n * 100) / 100))
    }
    expect(byId(after, 'web2_box~label').fontSize).toBe(30)
    expect(r.board.elements.find((e) => e.id === 'web2')).toMatchObject({ kind: 'group', members: ['web2_box', 'web2_disk1', 'web2_note'] })
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })
})

describe('style params', () => {
  const styled = parseBoard(`board "S" v1

use a chip@1 at(0,0) with(color=#ffc9c9)
use b chip@1 at(200,0) override(box.fill=#b2f2bb)
use c chip@1 at(400,0)

define chip@1 {
  board "Chip" v1
  template chip
  param color "#a5d8ff"

  node box "Chip" rect at(0,0) size(120,60) fill={color} stroke=#1e1e1e
}
`)

  it('round-trips {param} as a style value', () => {
    const text = printBoard(styled)
    expect(text).toContain('fill={color}')
    expect(parseBoard(text)).toEqual(styled)
    expect(checkBoard(styled)).toEqual([])
  })

  it('fills colours per copy, with the default when unset, and lets overrides win', () => {
    const scene = compileBoard(styled).elements
    const fill = (id: string) => scene.find((e) => e.id === id)?.backgroundColor
    expect(fill('a/box')).toBe('#ffc9c9')
    expect(fill('b/box')).toBe('#b2f2bb')
    expect(fill('c/box')).toBe('#a5d8ff')
  })

  it('shows the default colour on the template board itself', () => {
    const def = styled.definitions['chip@1']
    expect(compileBoard(def).elements.find((e) => e.id === 'box')?.backgroundColor).toBe('#a5d8ff')
  })

  it('only fills colours, and checks the values and names', () => {
    expect(() => parseBoard('board "x" v1\nnode a "A" rect width={w}\n')).toThrow(/only fill and stroke can be filled from a param/)
    const bad = { ...styled, elements: styled.elements.map((e) => (e.id === 'a' && e.kind === 'instance' ? { ...e, params: { color: 'very blue!' } } : e)) }
    expect(checkBoard(bad)).toContain(
      '"a": color is a colour, like #a5d8ff, not "very blue!"',
    )
    const undeclared = parseBoard('board "T" v1\ntemplate t\n\nnode a "A" rect fill={tint}\n')
    expect(checkBoard(undeclared)).toContain('a style uses {tint}, but the template has no param "tint"')
  })
})
