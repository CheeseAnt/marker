import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { commit, OpError } from './apply'
import { boardArb, styleArb } from './arbitrary'
import type { Op } from './ops'

const board = parseBoard(`board "t" v1
node a "A" rect at(0,0)
node b "B" rect below(a,40)
node c "C" rect right(b,40)
edge e1 a -> b
edge e2 b -> c
group g1 [a, b, e1]
group g2 [g1, c]
`)

describe('commit', () => {
  it('cascades a removal and inverts back exactly', () => {
    const r = commit(board, [{ op: 'remove', id: 'b' }])
    const ids = r.board.elements.map((e) => e.id)
    expect(ids).toEqual(['a', 'c', 'g1', 'g2'])
    // c was anchored to b, so it is pinned where it was.
    expect(r.board.elements.find((e) => e.id === 'c')).toMatchObject({ at: { kind: 'at' } })
    expect(r.board.elements.find((e) => e.id === 'g1')).toMatchObject({ members: ['a'] })
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })

  it('removes groups that become empty', () => {
    const r = commit(board, [{ op: 'remove', id: 'c' }, { op: 'remove', id: 'g1' }])
    expect(r.board.elements.some((e) => e.id === 'g2')).toBe(false)
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })

  it('merges style updates and null removes keys', () => {
    const b1 = commit(board, [{ op: 'update', id: 'a', set: { style: { fill: '#fff', stroke: '#000' } } }]).board
    const r = commit(b1, [{ op: 'update', id: 'a', set: { style: { fill: null }, label: 'A2' } }])
    expect(r.board.elements[0]).toMatchObject({ label: 'A2', style: { stroke: '#000' } })
    expect(r.board.elements[0].style).not.toHaveProperty('fill')
    expect(commit(r.board, r.inverse).board).toEqual(b1)
  })

  it('rejects broken references with readable messages, leaving the board unchanged', () => {
    const before = structuredClone(board)
    expect(() => commit(board, [{ op: 'add', element: { kind: 'edge', id: 'x', from: { id: 'a' }, to: { id: 'nope' } } as never }])).toThrow(
      /edge "x" to "nope" is not a node/,
    )
    expect(() => commit(board, [{ op: 'update', id: 'a', set: { at: { kind: 'rel', dir: 'below', of: 'b', gap: 1 } } }])).toThrow(
      /placement cycle/,
    )
    expect(() => commit(board, [{ op: 'update', id: 'a', set: { kind: 'text' } }])).toThrow(/cannot change "kind"/)
    expect(() => commit(board, [{ op: 'update', id: 'zzz', set: {} }])).toThrow(/op 1 \(update\): cannot update unknown/)
    expect(board).toEqual(before)
  })

  it('errors carry every issue', () => {
    try {
      commit(board, [{ op: 'add', element: { kind: 'group', id: 'g3', members: ['a', 'q'] } as never }])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(OpError)
      expect((e as OpError).issues).toEqual(expect.arrayContaining([
        'group "g3" has unknown member "q"',
        '"a" is in both groups "g1" and "g3"',
      ]))
    }
  })

  it('reorders and inverts', () => {
    const r = commit(board, [{ op: 'reorder', id: 'c', after: null }])
    expect(r.board.elements[0].id).toBe('c')
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })

  it('inverse restores any board after removing, restyling or reordering any element', () => {
    fc.assert(
      fc.property(boardArb, fc.nat(), fc.nat(), styleArb, fc.constantFrom('remove', 'update', 'reorder'), (b, i, j, style, kind) => {
        fc.pre(b.elements.length > 0)
        const id = b.elements[i % b.elements.length].id
        const other = b.elements[j % b.elements.length].id
        const op: Op =
          kind === 'remove'
            ? { op: 'remove', id }
            : kind === 'update'
              ? { op: 'update', id, set: { style, hints: { touched: true } } }
              : { op: 'reorder', id, after: other === id ? null : other }
        const r = commit(b, [op])
        expect(commit(r.board, r.inverse).board).toEqual(b)
      }),
      { numRuns: 400 },
    )
  })
})
