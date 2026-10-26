import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { boardArb } from '../model/arbitrary'
import { parseBoard } from './parse'
import { printBoard } from './print'
import { DslError } from './tokenize'

const SAMPLE = `board "System overview" v1
style default stroke=#1e1e1e rough=1 font=hand

node api "API Gateway" rect at(200,100) size(160,60) fill=#e3f2fd ~{seed:1934}
node db "Postgres" ellipse below(api,80)
node q "Job queue" diamond right(api,120)
edge e1 api -> db "queries" dashed
edge e2 api -> q
edge e3 q -- (900,40) via((700,40))
text n1 "TODO: auth\\nand \\"quotes\\"" at(420,40) fontSize=20
group g1 "Backend" [api, db, q]
image i1 asset:7f3a at(600,300) size(240,160)
draw d1 at(10,10) path="M0 0 Q 40 5 60 30" stroke=#c00 width=2
`

describe('DSL', () => {
  it('parses the sample', () => {
    const b = parseBoard(SAMPLE)
    expect(b.title).toBe('System overview')
    expect(b.defaults).toEqual({ font: 'hand', rough: 1, stroke: '#1e1e1e' })
    expect(b.elements.map((e) => e.id)).toEqual(['api', 'db', 'q', 'e1', 'e2', 'e3', 'n1', 'g1', 'i1', 'd1'])
    expect(b.elements[0]).toMatchObject({ shape: 'rect', at: { kind: 'at', x: 200, y: 100 }, size: { w: 160, h: 60 }, hints: { seed: 1934 } })
    expect(b.elements[1]).toMatchObject({ at: { kind: 'rel', dir: 'below', of: 'api', gap: 80 } })
    expect(b.elements[3]).toMatchObject({ head: '->', label: 'queries', style: { line: 'dashed' } })
    expect(b.elements[5]).toMatchObject({ head: '--', to: { point: { x: 900, y: 40 } }, via: [{ x: 700, y: 40 }] })
    expect(b.elements[6]).toMatchObject({ text: 'TODO: auth\nand "quotes"', style: { fontSize: 20 } })
  })

  it('prints the sample canonically', () => {
    expect(printBoard(parseBoard(SAMPLE))).toBe(SAMPLE)
  })

  it('splits arrows without spaces', () => {
    const b = parseBoard('board "x" v1\nnode a "" rect\nnode b-2 "" rect\nedge e a->b-2')
    expect(b.elements[2]).toMatchObject({ from: { id: 'a' }, to: { id: 'b-2' } })
  })

  it('ignores comments but keeps # colors', () => {
    const b = parseBoard('# header\nboard "x" v1\nnode a "" rect fill=#fff # trailing')
    expect(b.elements[0].style.fill).toBe('#fff')
  })

  it.each([
    ['node a "x" hexagon', /line 1:\d+: unknown shape "hexagon"/],
    ['node a "x', /unterminated string/],
    ['edge e a => b', /unexpected character ">"/],
    ['node a "x" rect bogus=1', /invalid style/],
    ['node a "" rect\nnode a "" rect', /line 2:\d+: duplicate id "a"/],
    ['widget w', /unknown statement "widget"/],
  ])('reports %j', (src, msg) => {
    expect(() => parseBoard(src)).toThrow(DslError)
    expect(() => parseBoard(src)).toThrow(msg)
  })

  it('round-trips generated boards', () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const text = printBoard(board)
        expect(parseBoard(text)).toEqual(board)
        expect(printBoard(parseBoard(text))).toBe(text)
      }),
      { numRuns: 300 },
    )
  })
})
