import { describe, expect, it } from 'vitest'
import type { ExElement } from '../compile/exTypes'
import { compileBoard } from '../compile/toExcalidraw'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import { checkBoard, commit } from '../model/apply'
import type { InstanceElement } from '../model/types'
import { expandSelection, insertCopyOps, replaceWithCopyOps, templateFromSelection, updateCopiesOps, type TemplateDraft } from './operations'

const board = parseBoard(`board "Shop" v1
style default font=normal

node lb "Load balancer" rect at(0,0) size(200,60)
node box "Web" rect at(300,200) size(160,80)
text note "nginx 1.27" below(box,10)
edge inner box -> note
edge e1 lb -> box
edge e2 lb -> note
`)

const draft: TemplateDraft = {
  name: 'server',
  description: 'A web server',
  params: [{ element: 'box', name: 'name' }],
  ports: [{ element: 'box', name: 'in', side: 'top' }],
}

const at = (els: ExElement[], id: string) => {
  const e = els.find((x) => x.id === id)!
  return { x: e.x, y: e.y, w: e.width }
}

describe('saving a selection as a template', () => {
  it('takes the selection with its inner edges, positioned from its top-left corner', () => {
    expect(expandSelection(board, ['box', 'note'])).toEqual(['box', 'note', 'inner'])
    const { template, bounds } = templateFromSelection(board, ['box', 'note'], draft)
    expect(bounds).toMatchObject({ x: 300, y: 200 })
    expect(template.template).toEqual({ name: 'server', description: 'A web server', params: [{ name: 'name', default: 'Web' }], ports: [{ name: 'in', target: 'box', side: 'top' }] })
    expect(template.elements.find((e) => e.id === 'box')).toMatchObject({ label: '{name}', at: { kind: 'at', x: 0, y: 0 } })
    expect(template.defaults).toEqual({ font: 'normal' })
    expect(checkBoard(template)).toEqual([])
    expect(parseBoard(printBoard(template))).toEqual(template)
  })

  it('replaces the selection with a copy that looks the same and keeps outside edges', () => {
    const { template, bounds } = templateFromSelection(board, ['box', 'note'], draft)
    const t = { name: 'server', version: 1, board: template }
    const r = commit(board, replaceWithCopyOps(board, ['box', 'note'], t, bounds))
    expect(r.board.elements.map((e) => e.id)).toEqual(['lb', 'e1', 'e2', 'server1'])
    expect(r.board.elements.find((e) => e.id === 'e1')).toMatchObject({ to: { id: 'server1', port: 'in' } })
    expect(r.board.elements.find((e) => e.id === 'e2')).toMatchObject({ to: { id: 'server1' } })
    const before = compileBoard(board).elements
    const after = compileBoard(r.board).elements
    expect(at(after, 'server1/box')).toEqual(at(before, 'box'))
    expect(after.find((e) => e.id === 'server1/box~label')?.text).toBe('Web')
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })
})

describe('copies and versions', () => {
  const v1 = { name: 'server', version: 1, board: templateFromSelection(board, ['box', 'note'], draft).template }

  it('inserts numbered copies and defines the template once', () => {
    let b = commit(board, insertCopyOps(board, v1, { params: { name: 'A' } })).board
    const ops = insertCopyOps(b, v1)
    expect(ops.map((o) => o.op)).toEqual(['add'])
    b = commit(b, ops).board
    expect(b.elements.filter((e) => e.kind === 'instance').map((e) => e.id)).toEqual(['server1', 'server2'])
    expect(Object.keys(b.definitions)).toEqual(['server@1'])
  })

  it('updates copies to a new version and reports what no longer fits', () => {
    let b = commit(board, insertCopyOps(board, v1, { params: { name: 'A' } })).board
    b = commit(b, [{ op: 'update', id: 'server1', set: { overrides: { note: { text: 'apache' }, box: { style: { fill: '#fff' } } } } }]).board
    const v2Board = parseBoard(printBoard(v1.board).replace('param name "Web"', 'param title "Web"').replace('{name}', '{title}').replace(/text note .*\n/, '').replace(/edge inner .*\n/, ''))
    const report = updateCopiesOps(b, { name: 'server', version: 2, board: v2Board })
    expect(report.copies).toEqual(['server1'])
    expect(report.dropped).toEqual(['server1: value for “name”', 'server1: changes to “note”'])
    const next = commit(b, report.ops).board
    expect((next.elements.find((e) => e.id === 'server1') as InstanceElement).template).toBe('server@2')
    expect(Object.keys(next.definitions)).toEqual(['server@2'])
  })

  it('updates only the copies asked for', () => {
    let b = commit(board, insertCopyOps(board, v1)).board
    b = commit(b, insertCopyOps(b, v1)).board
    const v2 = { name: 'server', version: 2, board: v1.board }
    const report = updateCopiesOps(b, v2, ['server2'])
    expect(report.copies).toEqual(['server2'])
    const next = commit(b, report.ops).board
    expect(next.elements.filter((e) => e.kind === 'instance').map((e) => (e as InstanceElement).template)).toEqual(['server@1', 'server@2'])
  })
})

describe('colour fill-ins', () => {
  it('turns a chosen fill into a param whose default is the current colour', () => {
    const { template } = templateFromSelection(board, ['box', 'note'], { ...draft, colours: [{ element: 'box', key: 'fill', name: 'color' }] })
    expect(template.elements.find((e) => e.id === 'box')?.style.fill).toBe('{color}')
    expect(template.template!.params.at(-1)).toEqual({ name: 'color', default: board.elements.find((e) => e.id === 'box')!.style.fill ?? 'transparent' })
    expect(checkBoard(template)).toEqual([])
  })
})
