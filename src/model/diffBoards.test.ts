import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { commit } from './apply'
import { boardArb } from './arbitrary'
import { diffBoards } from './diffBoards'

describe('diffBoards', () => {
  it('turns any valid board into any other, and the inverse turns it back', () => {
    fc.assert(
      fc.property(boardArb, boardArb, (a, b) => {
        const r = commit(a, diffBoards(a, b))
        expect(r.board).toEqual(b)
        expect(commit(r.board, r.inverse).board).toEqual(a)
      }),
      { numRuns: 400 },
    )
  })

  it('is empty for identical boards', () => {
    fc.assert(
      fc.property(boardArb, (a) => {
        expect(diffBoards(a, structuredClone(a))).toEqual([])
      }),
    )
  })
})
