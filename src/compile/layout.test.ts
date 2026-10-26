import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { commit } from '../model/apply'
import { resolveBoxes } from '../model/geometry'
import { placeUnplaced } from './layout'

describe('placeUnplaced', () => {
  it('places a new connected group below what it connects to, without overlaps', async () => {
    const board = parseBoard(`board "t" v1
node api "API" rect at(0,0)
node other "Other" rect at(0,200)
node db "Database" rect
node cache "Cache" rect
edge e1 api -> db
edge e2 db -> cache
`)
    const ops = await placeUnplaced(board)
    expect(ops.map((o) => o.op === 'update' && o.id).sort()).toEqual(['cache', 'db'])
    const placed = commit(board, ops).board
    const boxes = resolveBoxes(placed)
    const api = boxes.get('api')!
    const db = boxes.get('db')!
    const cache = boxes.get('cache')!
    expect(db.y).toBeGreaterThan(api.y + api.h)
    expect(cache.y).toBeGreaterThan(db.y + db.h)
    const all = [...boxes.values()]
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [a, b] = [all[i], all[j]]
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(disjoint).toBe(true)
      }
  })

  it('puts unconnected new elements right of the board', async () => {
    const board = parseBoard('board "t" v1\nnode a "A" rect at(0,0) size(100,50)\ntext t "loose"')
    const [op] = await placeUnplaced(board)
    expect(op).toMatchObject({ op: 'update', id: 't', set: { at: { kind: 'at', y: 0 } } })
    expect((op as unknown as { set: { at: { x: number } } }).set.at.x).toBeGreaterThan(100)
  })

  it('does nothing when everything is placed', async () => {
    expect(await placeUnplaced(parseBoard('board "t" v1\nnode a "A" rect at(0,0)'))).toEqual([])
  })

  it('centres unconnected new elements in the view, next to anything already there', async () => {
    const empty = parseBoard('board "t" v1\nnode n "New" rect size(120,60)')
    const [op] = await placeUnplaced(empty, { center: { x: 500, y: 300 } })
    expect(op).toMatchObject({ set: { at: { kind: 'at', x: 440, y: 270 } } })

    const busy = parseBoard('board "t" v1\nnode old "Old" rect at(440,270) size(120,60)\nnode n "New" rect size(120,60)')
    const [moved] = await placeUnplaced(busy, { center: { x: 500, y: 300 } })
    const at = (moved as unknown as { set: { at: { x: number; y: number } } }).set.at
    const placed = commit(busy, [moved]).board
    const boxes = resolveBoxes(placed)
    const [a, b] = [boxes.get('old')!, boxes.get('n')!]
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
    // The closest free spot, not far away.
    expect(Math.hypot(at.x - 440, at.y - 270)).toBeLessThan(200)
  })
})
