import type { Board, BoardElement, Endpoint, Hints, Placement, Point, Size, Style, StyleKey } from '../model/types'
import { isNumber } from './tokenize'

const STYLE_ORDER: StyleKey[] = ['fill', 'stroke', 'width', 'line', 'rough', 'pattern', 'opacity', 'font', 'fontSize', 'align']
const BARE_VALUE = /^[A-Za-z0-9_.#%+-]+$/

export function num(n: number): string {
  const r = Math.round(n * 100) / 100
  return String(Object.is(r, -0) ? 0 : r)
}

export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function value(v: string | number | boolean): string {
  if (typeof v === 'number') return num(v)
  if (typeof v === 'boolean') return String(v)
  // Strings that would read back as numbers or booleans need quotes to keep their type.
  return BARE_VALUE.test(v) && !isNumber(v) && v !== 'true' && v !== 'false' ? v : quote(v)
}

function point(p: Point): string {
  return `(${num(p.x)},${num(p.y)})`
}

function placement(p: Placement | undefined): string[] {
  if (!p) return []
  return p.kind === 'at' ? [`at${point(p)}`] : [`${p.dir}(${p.of},${num(p.gap)})`]
}

function size(s: Size | undefined): string[] {
  return s ? [`size(${num(s.w)},${num(s.h)})`] : []
}

function endpoint(e: Endpoint): string {
  return 'point' in e ? point(e.point) : e.port ? `${e.id}.${e.port}` : e.id
}

export function styleAttrs(style: Style): string[] {
  const out: string[] = []
  for (const key of STYLE_ORDER) {
    const v = style[key]
    if (v === undefined) continue
    out.push(key === 'line' ? String(v) : `${key}=${value(v)}`)
  }
  return out
}

function hints(h: Hints): string[] {
  const keys = Object.keys(h).sort()
  if (keys.length === 0) return []
  return [`~{${keys.map((k) => `${k}:${value(h[k])}`).join(', ')}}`]
}

export function printElement(el: BoardElement, opts: { hints?: boolean } = {}): string {
  const tail = [...styleAttrs(el.style), ...(opts.hints === false ? [] : hints(el.hints))]
  let parts: string[] = []
  switch (el.kind) {
    case 'node':
      parts = ['node', el.id, quote(el.label), el.shape, ...placement(el.at), ...size(el.size)]
      break
    case 'edge':
      parts = [
        'edge',
        el.id,
        endpoint(el.from),
        el.head,
        endpoint(el.to),
        ...(el.label !== undefined ? [quote(el.label)] : []),
        ...(el.via?.length ? [`via(${el.via.map(point).join(', ')})`] : []),
      ]
      break
    case 'text':
      parts = ['text', el.id, quote(el.text), ...placement(el.at)]
      break
    case 'group':
      parts = ['group', el.id, ...(el.label !== undefined ? [quote(el.label)] : []), `[${el.members.join(', ')}]`]
      break
    case 'image':
      parts = ['image', el.id, `asset:${el.asset}`, ...placement(el.at), ...size(el.size)]
      break
    case 'draw':
      parts = ['draw', el.id, `at${point(el.at)}`, `path=${quote(el.path)}`]
      break
    case 'instance': {
      parts = ['use', el.id, el.template, ...placement(el.at), ...(el.scale !== undefined ? [`scale(${num(el.scale)})`] : [])]
      const params = Object.keys(el.params).sort()
      if (params.length) parts.push(`with(${params.map((k) => `${k}=${quote(el.params[k])}`).join(', ')})`)
      const overrides = Object.keys(el.overrides)
        .sort()
        .flatMap((child) => {
          const o = el.overrides[child]
          return [
            ...(o.text !== undefined ? [`${child}.text=${quote(o.text)}`] : []),
            ...STYLE_ORDER.filter((k) => o.style?.[k] !== undefined).map((k) => `${child}.${k}=${value(o.style![k]!)}`),
          ]
        })
      if (overrides.length) parts.push(`override(${overrides.join(', ')})`)
      break
    }
  }
  return [...parts, ...tail].join(' ')
}

/**
 * Canonical text form: parse(print(b)) equals b, and print(parse(t)) === t for canonical t.
 * `hints: false` drops renderer hints, which is what the LLM sees.
 */
export function printBoard(board: Board, opts: { hints?: boolean; definitions?: boolean } = {}): string {
  const lines = [`board ${quote(board.title)} v${board.formatVersion}`]
  if (board.template) {
    const t = board.template
    lines.push(`template ${t.name}${t.description ? ` ${quote(t.description)}` : ''}`)
    for (const p of t.params) lines.push(`param ${p.name}${p.default ? ` ${quote(p.default)}` : ''}`)
    for (const p of t.ports) lines.push(`port ${p.name} ${p.target} ${p.side}`)
  }
  const defaults = styleAttrs(board.defaults)
  if (defaults.length) lines.push(`style default ${defaults.join(' ')}`)
  if (board.elements.length) lines.push('')
  for (const el of board.elements) lines.push(printElement(el, opts))
  if (opts.definitions !== false) {
    for (const key of Object.keys(board.definitions).sort()) {
      const inner = printBoard(board.definitions[key], opts).trimEnd().split('\n')
      lines.push('', `define ${key} {`, ...inner.map((l) => (l ? `  ${l}` : l)), '}')
    }
  }
  return lines.join('\n') + '\n'
}
