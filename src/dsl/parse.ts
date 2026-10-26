import {
  directions,
  elementSchema,
  emptyBoard,
  parseTemplateKey,
  portSides,
  type Override,
  type PortSide,
  shapes,
  styleSchema,
  type Board,
  type BoardElement,
  type Direction,
  type Endpoint,
  type Hints,
  type Placement,
  type Point,
  type Shape,
  type Size,
  type Style,
} from '../model/types'
import { DslError, isNumber, tokenizeLine, type Token } from './tokenize'

export const DEFAULT_GAP = 60
const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const
const NUMERIC_STYLE_KEYS = new Set(['width', 'rough', 'opacity', 'fontSize'])

class LineParser {
  private i = 0
  readonly tokens: Token[]
  readonly line: number

  constructor(tokens: Token[], line: number) {
    this.tokens = tokens
    this.line = line
  }

  fail(message: string, tok: Token | undefined = this.tokens[this.i]): never {
    throw new DslError(this.line, tok?.col ?? (this.tokens.at(-1)?.col ?? 0) + 1, message)
  }

  peek(): Token | undefined {
    return this.tokens[this.i]
  }

  done(): boolean {
    return this.i >= this.tokens.length
  }

  next(): Token {
    const tok = this.tokens[this.i++]
    if (!tok) this.fail('unexpected end of line')
    return tok
  }

  word(what: string): string {
    const tok = this.next()
    if (tok.t !== 'word') this.fail(`expected ${what}`, tok)
    return tok.v
  }

  string(what: string): string {
    const tok = this.next()
    if (tok.t !== 'string') this.fail(`expected ${what} in double quotes`, tok)
    return tok.v
  }

  number(what: string): number {
    const tok = this.next()
    if (tok.t !== 'word' || !isNumber(tok.v)) this.fail(`expected ${what} (a number)`, tok)
    return Number(tok.v)
  }

  punct(v: string) {
    const tok = this.next()
    if (tok.t !== 'punct' || tok.v !== v) this.fail(`expected "${v}"`, tok)
  }

  isPunct(v: string): boolean {
    const tok = this.peek()
    return tok?.t === 'punct' && tok.v === v
  }

  isWord(...vs: string[]): boolean {
    const tok = this.peek()
    return tok?.t === 'word' && (vs.length === 0 || vs.includes(tok.v))
  }

  /** Parses `(a, b, ...)` of numbers. */
  numbers(count: number, what: string): number[] {
    this.punct('(')
    const out: number[] = []
    for (let k = 0; k < count; k++) {
      if (k > 0) this.punct(',')
      out.push(this.number(what))
    }
    this.punct(')')
    return out
  }

  point(): Point {
    const [x, y] = this.numbers(2, 'a coordinate')
    return { x, y }
  }
}

function parsePlacement(p: LineParser): Placement | undefined {
  if (p.isWord('at')) {
    p.next()
    const { x, y } = p.point()
    return { kind: 'at', x, y }
  }
  if (p.isWord(...directions)) {
    const dir = p.word('a direction') as Direction
    p.punct('(')
    const of = p.word('an element id')
    let gap = DEFAULT_GAP
    if (p.isPunct(',')) {
      p.next()
      gap = p.number('a gap')
    }
    p.punct(')')
    return { kind: 'rel', dir, of, gap }
  }
  return undefined
}

function parseSize(p: LineParser): Size | undefined {
  if (!p.isWord('size')) return undefined
  p.next()
  const [w, h] = p.numbers(2, 'a size')
  return { w, h }
}

function parseEndpoint(p: LineParser): Endpoint {
  if (p.isPunct('(')) return { point: p.point() }
  const tok = p.next()
  if (tok.t !== 'word') p.fail('expected an element id or (x,y)', tok)
  const [id, port, extra] = tok.v.split('.')
  if (extra !== undefined || !id) p.fail(`bad endpoint "${tok.v}"`, tok)
  return port ? { id, port } : { id }
}

/** Trailing `key=value`, line-style keywords and `~{hints}`. */
function parseAttrs(p: LineParser, extra: Record<string, (p: LineParser) => void> = {}) {
  const style: Record<string, unknown> = {}
  let hints: Hints = {}
  while (!p.done()) {
    const tok = p.next()
    if (tok.t === 'hints') {
      hints = { ...hints, ...tok.v }
      continue
    }
    if (tok.t !== 'word') p.fail('expected an attribute', tok)
    if ((LINE_STYLES as readonly string[]).includes(tok.v)) {
      style.line = tok.v
      continue
    }
    p.punct('=')
    if (extra[tok.v]) {
      extra[tok.v](p)
      continue
    }
    const valTok = p.next()
    if (valTok.t !== 'word' && valTok.t !== 'string') p.fail(`expected a value for "${tok.v}"`, valTok)
    style[tok.v] = NUMERIC_STYLE_KEYS.has(tok.v) && isNumber(valTok.v) ? Number(valTok.v) : valTok.v
  }
  const parsed = styleSchema.strict().safeParse(style)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    p.fail(`invalid style ${issue.path.join('.') || issue.message}: ${issue.message}`)
  }
  return { style: parsed.data as Style, hints }
}

function parseElement(keyword: string, p: LineParser): BoardElement {
  const id = p.word('an element id')
  switch (keyword) {
    case 'node': {
      const label = p.string('a label')
      const shape = p.word('a shape') as Shape
      if (!shapes.includes(shape)) p.fail(`unknown shape "${shape}" (use ${shapes.join(', ')})`)
      const at = parsePlacement(p)
      const size = parseSize(p)
      return { kind: 'node', id, label, shape, ...(at && { at }), ...(size && { size }), ...parseAttrs(p) }
    }
    case 'edge': {
      const from = parseEndpoint(p)
      const headTok = p.next()
      if (headTok.t !== 'head') p.fail('expected ->, <-, <-> or --', headTok)
      const to = parseEndpoint(p)
      const label = p.peek()?.t === 'string' ? p.string('a label') : undefined
      let via: Point[] | undefined
      if (p.isWord('via')) {
        p.next()
        p.punct('(')
        via = []
        while (!p.isPunct(')')) {
          if (via.length) p.punct(',')
          via.push(p.point())
        }
        p.punct(')')
      }
      return {
        kind: 'edge',
        id,
        from,
        to,
        head: headTok.v,
        ...(label !== undefined && { label }),
        ...(via && { via }),
        ...parseAttrs(p),
      }
    }
    case 'text': {
      const text = p.string('the text')
      const at = parsePlacement(p)
      return { kind: 'text', id, text, ...(at && { at }), ...parseAttrs(p) }
    }
    case 'group': {
      const label = p.peek()?.t === 'string' ? p.string('a label') : undefined
      p.punct('[')
      const members: string[] = []
      while (!p.isPunct(']')) {
        if (members.length) p.punct(',')
        members.push(p.word('a member id'))
      }
      p.punct(']')
      return { kind: 'group', id, ...(label !== undefined && { label }), members, ...parseAttrs(p) }
    }
    case 'image': {
      const ref = p.word('asset:<id>')
      if (!ref.startsWith('asset:') || ref.length <= 6) p.fail('expected asset:<id>')
      const at = parsePlacement(p)
      if (!at) p.fail('images need a placement, e.g. at(0,0)')
      const size = parseSize(p)
      if (!size) p.fail('images need size(w,h)')
      return { kind: 'image', id, asset: ref.slice(6), at, size, ...parseAttrs(p) }
    }
    case 'use': {
      const template = p.word('a template like server@1')
      if (!/^[A-Za-z_][A-Za-z0-9_-]*@\d+$/.test(template)) p.fail('expected a template like server@1')
      const at = parsePlacement(p)
      let scale: number | undefined
      if (p.isWord('scale')) {
        p.next()
        ;[scale] = p.numbers(1, 'a scale')
      }
      const params: Record<string, string> = {}
      if (p.isWord('with')) {
        p.next()
        parseList(p, (key) => {
          const tok = p.next()
          if (tok.t !== 'string' && tok.t !== 'word') p.fail(`expected a value for "${key}"`, tok)
          params[key] = tok.v
        })
      }
      const overrides: Record<string, Override> = {}
      if (p.isWord('override')) {
        p.next()
        parseList(p, (path) => {
          const dot = path.lastIndexOf('.')
          if (dot <= 0) p.fail(`expected child.field, like box.fill, not "${path}"`)
          const child = path.slice(0, dot)
          const field = path.slice(dot + 1)
          const tok = p.next()
          if (tok.t !== 'string' && tok.t !== 'word') p.fail(`expected a value for "${path}"`, tok)
          const o = (overrides[child] ??= {})
          if (field === 'text') o.text = tok.v
          else {
            const style = styleSchema.strict().safeParse({ [field]: NUMERIC_STYLE_KEYS.has(field) && isNumber(tok.v) ? Number(tok.v) : tok.v })
            if (!style.success) p.fail(`invalid override "${path}": ${style.error.issues[0].message}`, tok)
            o.style = { ...o.style, ...style.data }
          }
        })
      }
      return {
        kind: 'instance',
        id,
        template,
        params,
        overrides,
        ...(at && { at }),
        ...(scale !== undefined && { scale }),
        ...parseAttrs(p),
      }
    }
    case 'draw': {
      if (!p.isWord('at')) p.fail('drawings need at(x,y)')
      p.next()
      const at = p.point()
      let path = ''
      const attrs = parseAttrs(p, { path: (lp) => (path = lp.string('path data')) })
      if (!path) p.fail('drawings need path="..."')
      return { kind: 'draw', id, at, path, ...attrs }
    }
  }
  return p.fail(`unknown statement "${keyword}"`)
}

/** Parses `(key=value, key=value)`, calling `value` after each `key=` to read the value. */
function parseList(p: LineParser, value: (key: string) => void) {
  p.punct('(')
  let first = true
  while (!p.isPunct(')')) {
    if (!first) p.punct(',')
    first = false
    const key = p.word('a name')
    p.punct('=')
    value(key)
  }
  p.punct(')')
}

const DEFINE_OPEN = /^\s*define\s+(\S+)\s*\{\s*$/

/** Parses board text. Throws DslError with a line and column on the first problem. */
export function parseBoard(src: string): Board {
  return parseLines(src.split('\n'), 0, true)
}

function parseLines(lines: string[], offset: number, allowDefinitions: boolean): Board {
  const board = emptyBoard()
  let sawHeader = false
  let skipUntil = -1
  lines.forEach((raw, idx) => {
    const lineNo = offset + idx + 1
    if (idx <= skipUntil) return
    // define <key> { ... } holds a template's board, embedded so the file stands alone.
    const define = raw.match(DEFINE_OPEN)
    if (define) {
      if (!allowDefinitions) throw new DslError(lineNo, 1, 'definitions cannot be nested; put every define at the top level')
      const key = define[1]
      if (!/^[A-Za-z_][A-Za-z0-9_-]*@\d+$/.test(key)) throw new DslError(lineNo, raw.indexOf(key) + 1, 'expected a template like server@1')
      const close = lines.findIndex((l, j) => j > idx && l.trim() === '}')
      if (close < 0) throw new DslError(lineNo, 1, `define ${key} is missing its closing "}"`)
      const inner = parseLines(lines.slice(idx + 1, close), lineNo, false)
      if (!inner.template) throw new DslError(lineNo, 1, `define ${key} needs a "template" line`)
      const { name } = parseTemplateKey(key)
      if (inner.template.name !== name) throw new DslError(lineNo, 1, `define ${key} holds template "${inner.template.name}"`)
      if (board.definitions[key]) throw new DslError(lineNo, 1, `${key} is defined twice`)
      board.definitions[key] = inner
      skipUntil = close
      return
    }
    const tokens = tokenizeLine(raw, lineNo)
    if (tokens.length === 0) return
    const p: LineParser = new LineParser(tokens, lineNo)
    const keyword = p.word('a statement')
    if (keyword === 'board') {
      if (sawHeader) p.fail('only one "board" line is allowed')
      sawHeader = true
      board.title = p.string('a title')
      const v = p.word('a format version like v1')
      if (!/^v\d+$/.test(v)) p.fail('expected a format version like v1')
      board.formatVersion = Number(v.slice(1))
      if (!p.done()) p.fail('unexpected text after the board header')
      return
    }
    if (keyword === 'template') {
      if (board.template) p.fail('only one "template" line is allowed')
      const name = p.word('a template name')
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) p.fail('template names are identifiers like server')
      const description = p.peek()?.t === 'string' ? p.string('a description') : ''
      if (!p.done()) p.fail('unexpected text after the template line')
      board.template = { name, description, params: [], ports: [] }
      return
    }
    if (keyword === 'param' || keyword === 'port') {
      if (!board.template) p.fail(`"${keyword}" lines come after the "template" line`)
      if (keyword === 'param') {
        const name = p.word('a parameter name')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) p.fail('parameter names are identifiers like name')
        const fallback = p.peek()?.t === 'string' ? p.string('a default value') : ''
        board.template.params.push({ name, default: fallback })
      } else {
        const name = p.word('a port name')
        const target = p.word('the element the port is on')
        const side = (p.done() ? 'center' : p.word('a side')) as PortSide
        if (!portSides.includes(side)) p.fail(`ports are on the ${portSides.join(', ')}`)
        board.template.ports.push({ name, target, side })
      }
      if (!p.done()) p.fail(`unexpected text after the ${keyword}`)
      return
    }
    if (keyword === 'style') {
      if (p.word('"default"') !== 'default') p.fail('only "style default" is supported')
      board.defaults = { ...board.defaults, ...parseAttrs(p).style }
      return
    }
    const element = parseElement(keyword, p)
    const parsed = elementSchema.safeParse(element)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      p.fail(`${issue.path.join('.')}: ${issue.message}`, tokens[0])
    }
    if (board.elements.some((e) => e.id === parsed.data.id)) p.fail(`duplicate id "${parsed.data.id}"`, tokens[1])
    board.elements.push(parsed.data)
  })
  return board
}
