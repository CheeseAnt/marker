import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { commit } from '../model/apply'
import { boardArb } from '../model/arbitrary'
import { diffBoards } from '../model/diffBoards'
import type { Op } from '../model/ops'
import type { Board } from '../model/types'
import { describeOps } from './describe'
import { emptyHistory, jumpTo, record, redo, undo, type History } from './history'

function apply(board: Board, history: History, ops: Op[], id: string) {
  const r = commit(board, ops)
  return { board: r.board, history: record(history, { id, ts: 0, source: 'manual', title: id, ops: r.ops, inverse: r.inverse }) }
}

describe('history', () => {
  it('undoes and redoes any sequence of edits exactly', () => {
    fc.assert(
      fc.property(boardArb, fc.array(boardArb, { minLength: 1, maxLength: 5 }), (start, targets) => {
        const states = [start]
        let board = start
        let history = emptyHistory()
        targets.forEach((target, i) => {
          ;({ board, history } = apply(board, history, diffBoards(board, target), `t${i}`))
          states.push(board)
        })
        for (let i = states.length - 2; i >= 0; i--) {
          ;({ board, history } = undo(board, history)!)
          expect(board).toEqual(states[i])
        }
        expect(undo(board, history)).toBeUndefined()
        for (let i = 1; i < states.length; i++) {
          ;({ board, history } = redo(board, history)!)
          expect(board).toEqual(states[i])
        }
        expect(redo(board, history)).toBeUndefined()
        // Jumping anywhere lands on the matching state.
        const back = jumpTo(board, history, null)
        expect(back.board).toEqual(start)
        const mid = Math.floor(targets.length / 2)
        expect(jumpTo(back.board, back.history, `t${mid}`).board).toEqual(states[mid + 1])
      }),
      { numRuns: 150 },
    )
  })

  it('drops redo after a new edit and caps its length', () => {
    let board = parseBoard('board "t" v1\nnode a "A" rect at(0,0)')
    let history = emptyHistory()
    ;({ board, history } = apply(board, history, [{ op: 'update', id: 'a', set: { label: 'B' } }], 'one'))
    ;({ board, history } = undo(board, history)!)
    expect(history.future).toHaveLength(1)
    ;({ board, history } = apply(board, history, [{ op: 'update', id: 'a', set: { label: 'C' } }], 'two'))
    expect(history.future).toEqual([])
    let capped = emptyHistory()
    for (let i = 0; i < 10; i++) capped = record(capped, { ...history.past[0], id: `x${i}` }, 4)
    expect(capped.past.map((t) => t.id)).toEqual(['x6', 'x7', 'x8', 'x9'])
  })
})

describe('describeOps', () => {
  const board = parseBoard(`board "t" v1
node api "API Gateway" rect at(0,0)
node db "" ellipse at(0,200)
edge e1 api -> db
`)
  const title = (ops: Op[]) => describeOps(board, ops)

  it.each<[Op[], string]>([
    [[{ op: 'update', id: 'api', set: { at: { kind: 'at', x: 10, y: 0 } } }], 'Moved “API Gateway”'],
    [[{ op: 'update', id: 'db', set: { size: { w: 50, h: 50 }, at: { kind: 'at', x: 0, y: 0 } } }], 'Resized shape db'],
    [[{ op: 'update', id: 'api', set: { style: { fill: '#fff' }, hints: { seed: 1 } } }], 'Restyled “API Gateway”'],
    [[{ op: 'update', id: 'api', set: { label: 'Edge' } }], 'Renamed “API Gateway”'],
    [[{ op: 'remove', id: 'api' }], 'Deleted “API Gateway”'],
    [[{ op: 'add', element: { kind: 'node', id: 'n', label: 'Cache', shape: 'rect', style: {}, hints: {} } }], 'Added “Cache”'],
    [[{ op: 'add', element: { kind: 'group', id: 'g', members: ['api', 'db'], style: {}, hints: {} } }], 'Grouped 2 elements'],
    [[{ op: 'reorder', id: 'api', after: 'e1' }], 'Changed stacking order'],
    [[{ op: 'board', set: { title: 'New' } }], 'Changed board settings'],
    [
      [
        { op: 'board', set: { title: 'New' } },
        { op: 'add', element: { kind: 'text', id: 't', text: 'Hi', style: {}, hints: {} } },
      ],
      'Added “Hi”',
    ],
    [
      [
        { op: 'update', id: 'api', set: { at: { kind: 'at', x: 10, y: 0 } } },
        { op: 'update', id: 'db', set: { at: { kind: 'at', x: 10, y: 0 } } },
      ],
      'Moved 2 elements',
    ],
  ])('%#: %s', (ops, expected) => {
    expect(() => commit(board, ops)).not.toThrow()
    expect(title(ops)).toBe(expected)
  })
})
