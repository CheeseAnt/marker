import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { commit, OpError } from './apply'
import { resolveBoxes } from './geometry'
import { committedBoardArb, styleArb } from './arbitrary'
import type { Op } from './ops'

const board = parseBoard(`board "t" v1
node a "A" rect at(0,0)
node b "B" rect at(0,100)
node c "C" rect at(200,100)
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
    expect(() => commit(board, [{ op: 'update', id: 'a', set: { at: { kind: 'rel', dir: 'below', of: 'a', gap: 1 } } }])).toThrow(
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

  it('pins relative placements to where they resolve, so they no longer follow their anchor', () => {
    const r = commit(board, [
      { op: 'add', element: { kind: 'node', id: 'd', label: 'D', shape: 'rect', at: { kind: 'rel', dir: 'below', of: 'c', gap: 40 }, size: { w: 100, h: 50 }, style: {}, hints: {} } },
    ])
    // c is 160x80 by default at (200,100): d is centred under it, 40px below.
    const box = resolveBoxes(r.board).get('c')!
    expect(r.board.elements.find((e) => e.id === 'd')).toMatchObject({ at: { kind: 'at', x: Math.round(box.x + box.w / 2 - 50), y: box.y + box.h + 40 } })
    expect(commit(r.board, r.inverse).board).toEqual(board)
    const moved = commit(r.board, [{ op: 'update', id: 'c', set: { at: { kind: 'at', x: 900, y: 900 } } }]).board
    expect(moved.elements.find((e) => e.id === 'd')).toEqual(r.board.elements.find((e) => e.id === 'd'))
  })

  it('cascades a removal by pinning what is placed relative to it', () => {
    const r = commit(board, [
      { op: 'update', id: 'c', set: { at: { kind: 'rel', dir: 'right', of: 'b', gap: 40 } } },
      { op: 'remove', id: 'b' },
    ])
    expect(r.board.elements.find((e) => e.id === 'c')).toMatchObject({ at: { kind: 'at' } })
  })

  it('leaves placements relative to an element with no position yet', () => {
    const unplaced = parseBoard('board "t" v1\nnode a "A" rect\nnode b "B" rect below(a,40)\nnode c "C" rect right(b,40)\n')
    expect(commit(unplaced, []).board).toEqual(unplaced)
    const placed = commit(unplaced, [{ op: 'update', id: 'a', set: { at: { kind: 'at', x: 0, y: 0 } } }]).board
    expect(placed.elements.map((e) => e.kind === 'node' && e.at?.kind)).toEqual(['at', 'at', 'at'])
  })

  it('reorders and inverts', () => {
    const r = commit(board, [{ op: 'reorder', id: 'c', after: null }])
    expect(r.board.elements[0].id).toBe('c')
    expect(commit(r.board, r.inverse).board).toEqual(board)
  })

  it('inverse restores any board after removing, restyling or reordering any element', () => {
    fc.assert(
      fc.property(committedBoardArb, fc.nat(), fc.nat(), styleArb, fc.constantFrom('remove', 'update', 'reorder'), (b, i, j, style, kind) => {
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
