import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import { commit } from './apply'
import { shortIdOps } from './shortIds'

const LONG = 'Rk3hTq9vX2mLp8sWbY4nA'
const LONG2 = 'x-Zq81LmPq0wE7tRvBn3u'

describe('short ids for hand-drawn elements', () => {
  const board = parseBoard(`board "s" v1
node rect1 "Taken" rect at(0,0)
node ${LONG} "Drawn" rect at(200,0)
node api "API" ellipse at(200,140)
edge x${LONG2} ${LONG} -> api
group g [${LONG}, api]
frame f "Area" [${LONG}]
`)

  it('renames to the next free short id and carries every reference along', () => {
    const ops = shortIdOps(board, [LONG, `x${LONG2}`, 'api'])
    expect(ops).toEqual([
      { op: 'rename', from: LONG, to: 'rect2' },
      { op: 'rename', from: `x${LONG2}`, to: 'arrow1' },
    ])
    const { board: next, inverse } = commit(board, ops)
    expect(printBoard(next)).toBe(`board "s" v1

node rect1 "Taken" rect at(0,0)
node rect2 "Drawn" rect at(200,0)
node api "API" ellipse at(200,140)
edge arrow1 rect2 -> api
group g [rect2, api]
frame f "Area" [rect2]
`)
    expect(commit(next, inverse).board).toEqual(board)
  })

  it('refuses a name that is taken', () => {
    expect(() => commit(board, [{ op: 'rename', from: LONG, to: 'api' }])).toThrow(/already exists/)
  })
})
