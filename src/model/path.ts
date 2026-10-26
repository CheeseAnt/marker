import type { Point } from './types'

export interface ParsedPath {
  points: Point[]
  bounds: { x: number; y: number; w: number; h: number }
}

const CURVE_SAMPLES = 12

/**
 * Flattens SVG path data (M, L, H, V, Q, C, Z in absolute and relative forms) into a polyline.
 * Unknown commands are an error so the LLM repair loop can report them.
 */
export function parsePath(d: string): ParsedPath {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  const points: Point[] = []
  let i = 0
  let cmd = ''
  let cur: Point = { x: 0, y: 0 }
  let start: Point = { x: 0, y: 0 }

  const num = () => {
    const t = tokens[i++]
    const n = Number(t)
    if (t === undefined || Number.isNaN(n)) throw new Error(`path: expected a number near token ${i}`)
    return n
  }
  const pt = (rel: boolean): Point => {
    const x = num()
    const y = num()
    return rel ? { x: cur.x + x, y: cur.y + y } : { x, y }
  }

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    else if (!cmd) throw new Error('path: must start with a command')
    const rel = cmd === cmd.toLowerCase()
    switch (cmd.toUpperCase()) {
      case 'M':
        cur = pt(rel)
        start = cur
        points.push(cur)
        // Further coordinate pairs after M are implicit L commands.
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
        cur = pt(rel)
        points.push(cur)
        break
      case 'H':
        cur = { x: rel ? cur.x + num() : num(), y: cur.y }
        points.push(cur)
        break
      case 'V':
        cur = { x: cur.x, y: rel ? cur.y + num() : num() }
        points.push(cur)
        break
      case 'Q': {
        const c = pt(rel)
        const end = pt(rel)
        sample(cur, end, (t) => quad(cur, c, end, t), points)
        cur = end
        break
      }
      case 'C': {
        const c1 = pt(rel)
        const c2 = pt(rel)
        const end = pt(rel)
        sample(cur, end, (t) => cubic(cur, c1, c2, end, t), points)
        cur = end
        break
      }
      case 'Z':
        cur = start
        points.push(cur)
        break
      default:
        throw new Error(`path: unsupported command "${cmd}"`)
    }
  }
  if (points.length === 0) throw new Error('path: no points')
  return { points, bounds: boundsOf(points) }
}

function sample(_from: Point, _to: Point, f: (t: number) => Point, out: Point[]) {
  for (let s = 1; s <= CURVE_SAMPLES; s++) out.push(f(s / CURVE_SAMPLES))
}

function quad(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y }
}

function cubic(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y }
}

export function boundsOf(points: Point[]) {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits
  const r = Math.round(n * f) / f
  return Object.is(r, -0) ? 0 : r
}

/** Encodes a polyline as compact absolute path data (used for hand-drawn strokes). */
export function pointsToPath(points: readonly Point[]): string {
  return points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
    .join(' ')
}
