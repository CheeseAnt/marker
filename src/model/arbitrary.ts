// Test-only fast-check generators for valid boards.
import fc from 'fast-check'
import { FONT_IDS } from './fonts'
import type { Board, BoardElement, Endpoint, Hints, Placement, Style } from './types'

const coord = fc.integer({ min: -2000, max: 2000 })
const dim = fc.integer({ min: 10, max: 600 })
const text = fc.string({ maxLength: 24 })
const color = fc.constantFrom('#1e1e1e', '#e3f2fd', '#c00', 'transparent', '#fff3bf')

export const styleArb: fc.Arbitrary<Style> = fc.record(
  {
    fill: color,
    stroke: color,
    width: fc.constantFrom(1, 2, 4),
    line: fc.constantFrom('solid', 'dashed', 'dotted'),
    rough: fc.constantFrom(0, 1, 2),
    pattern: fc.constantFrom('hachure', 'solid', 'cross', 'zigzag'),
    opacity: fc.integer({ min: 0, max: 100 }),
    font: fc.constantFrom(...FONT_IDS),
    fontSize: fc.constantFrom(16, 20, 28, 36),
    align: fc.constantFrom('left', 'center', 'right'),
  },
  { requiredKeys: [] },
)

export const hintsArb: fc.Arbitrary<Hints> = fc.dictionary(
  fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,8}$/),
  fc.oneof(fc.integer({ min: -1e6, max: 1e6 }), fc.boolean(), fc.string({ maxLength: 10 })),
  { maxKeys: 3 },
)

const path = fc
  .array(fc.tuple(coord, coord), { minLength: 1, maxLength: 6 })
  .map((pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' '))

/** A board whose references (edges, anchors, groups) all point at earlier elements. */
export const boardArb: fc.Arbitrary<Board> = fc
  .array(fc.nat({ max: 5 }), { maxLength: 14 })
  .chain((kinds) =>
    fc.tuple(
      fc.constant(kinds),
      ...kinds.map(() =>
        fc.record({
          style: styleArb,
          hints: hintsArb,
          label: text,
          pick: fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
          x: coord,
          y: coord,
          w: dim,
          h: dim,
          flags: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
          path,
        }),
      ),
      fc.string({ maxLength: 20 }),
    ),
  )
  .map(([kinds, ...rest]) => {
    const title = rest.pop() as string
    const elements: BoardElement[] = []
    const grouped = new Set<string>()
    kinds.forEach((k, i) => {
      const r = rest[i] as {
        style: Style
        hints: Hints
        label: string
        pick: number[]
        x: number
        y: number
        w: number
        h: number
        flags: boolean[]
        path: string
      }
      const id = `e${i}`
      const anchors = elements.filter((e) => e.kind === 'node' || e.kind === 'text' || e.kind === 'image')
      const pickAnchor = (n: number) => anchors[n % anchors.length]
      const placement = (): Placement | undefined => {
        if (r.flags[0] && anchors.length) {
          const dirs = ['below', 'above', 'left', 'right'] as const
          return { kind: 'rel', dir: dirs[r.pick[1] % 4], of: pickAnchor(r.pick[0]).id, gap: r.pick[2] % 200 }
        }
        return r.flags[1] ? { kind: 'at', x: r.x, y: r.y } : undefined
      }
      const base = { id, style: r.style, hints: r.hints }
      switch (anchors.length < 2 && k === 1 ? 0 : k) {
        case 0: {
          const shapes = ['rect', 'ellipse', 'diamond', 'sticky'] as const
          const at = placement()
          elements.push({
            ...base,
            kind: 'node',
            label: r.label,
            shape: shapes[r.pick[3] % 4],
            ...(at && { at }),
            ...(r.flags[2] && { size: { w: r.w, h: r.h } }),
          })
          break
        }
        case 1: {
          const end = (n: number, asPoint: boolean): Endpoint =>
            asPoint ? { point: { x: r.x + n, y: r.y } } : { id: pickAnchor(n).id }
          elements.push({
            ...base,
            kind: 'edge',
            from: end(r.pick[0], false),
            to: end(r.pick[1], r.flags[3]),
            head: (['->', '<-', '<->', '--'] as const)[r.pick[2] % 4],
            ...(r.flags[1] && { label: r.label }),
            ...(r.flags[2] && { via: [{ x: r.x, y: r.y }] }),
          })
          break
        }
        case 2: {
          const at = placement()
          elements.push({ ...base, kind: 'text', text: r.label || 'x', ...(at && { at }) })
          break
        }
        case 3:
          elements.push({ ...base, kind: 'image', asset: `a${r.pick[0]}`, at: { kind: 'at', x: r.x, y: r.y }, size: { w: r.w, h: r.h } })
          break
        case 4:
          elements.push({ ...base, kind: 'draw', at: { x: r.x, y: r.y }, path: r.path })
          break
        default: {
          const candidates = elements.filter((e) => !grouped.has(e.id))
          if (candidates.length === 0) break
          const members = candidates.filter((_, j) => (r.pick[j % 4] + j) % 2 === 0).map((e) => e.id)
          if (members.length === 0) members.push(candidates[0].id)
          members.forEach((m) => grouped.add(m))
          elements.push({ ...base, kind: 'group', ...(r.flags[1] && { label: r.label }), members })
        }
      }
    })
    return { title, formatVersion: 1, defaults: {}, elements }
  })
