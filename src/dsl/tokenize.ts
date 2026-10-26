import type { Hints } from '../model/types'

export type Token =
  | { t: 'word'; v: string; col: number }
  | { t: 'string'; v: string; col: number }
  | { t: 'punct'; v: '(' | ')' | ',' | '[' | ']' | '='; col: number }
  | { t: 'head'; v: '->' | '<-' | '<->' | '--'; col: number }
  | { t: 'hints'; v: Hints; col: number }

export class DslError extends Error {
  readonly line: number
  readonly col: number
  constructor(line: number, col: number, message: string) {
    super(`line ${line}:${col}: ${message}`)
    this.name = 'DslError'
    this.line = line
    this.col = col
  }
}

// Includes @ (template keys like server@3) and / (paths into nested template copies).
const WORD = /[A-Za-z0-9_.#:%+@/-]/

function readString(src: string, start: number, line: number): { v: string; end: number } {
  let v = ''
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i]
    if (c === '"') return { v, end: i + 1 }
    if (c === '\\') {
      const n = src[++i]
      if (n === 'n') v += '\n'
      else if (n === '"' || n === '\\') v += n
      else throw new DslError(line, i + 1, `unknown escape "\\${n ?? ''}"`)
    } else {
      v += c
    }
  }
  throw new DslError(line, start + 1, 'unterminated string')
}

function readHints(src: string, start: number, line: number): { v: Hints; end: number } {
  const hints: Hints = {}
  let i = start + 2
  const skipWs = () => {
    while (src[i] === ' ' || src[i] === '\t') i++
  }
  for (;;) {
    skipWs()
    if (src[i] === '}') return { v: hints, end: i + 1 }
    const keyStart = i
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++
    const key = src.slice(keyStart, i)
    if (!key) throw new DslError(line, i + 1, 'expected a hint name in ~{...}')
    skipWs()
    if (src[i] !== ':') throw new DslError(line, i + 1, `expected ":" after hint "${key}"`)
    i++
    skipWs()
    if (src[i] === '"') {
      const s = readString(src, i, line)
      hints[key] = s.v
      i = s.end
    } else {
      const vStart = i
      while (i < src.length && !/[\s,}]/.test(src[i])) i++
      const raw = src.slice(vStart, i)
      if (!raw) throw new DslError(line, i + 1, `missing value for hint "${key}"`)
      hints[key] = raw === 'true' ? true : raw === 'false' ? false : isNumber(raw) ? Number(raw) : raw
    }
    skipWs()
    if (src[i] === ',') i++
    else if (src[i] !== '}') throw new DslError(line, i + 1, 'expected "," or "}" in ~{...}')
  }
}

export function isNumber(s: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(s)
}

export function tokenizeLine(src: string, line: number): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const col = i + 1
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
      break
    } else if (c === '"') {
      const s = readString(src, i, line)
      tokens.push({ t: 'string', v: s.v, col })
      i = s.end
    } else if (c === '~' && src[i + 1] === '{') {
      const h = readHints(src, i, line)
      tokens.push({ t: 'hints', v: h.v, col })
      i = h.end
    } else if (src.startsWith('<->', i)) {
      tokens.push({ t: 'head', v: '<->', col })
      i += 3
    } else if (src.startsWith('->', i) || src.startsWith('<-', i) || src.startsWith('--', i)) {
      tokens.push({ t: 'head', v: src.slice(i, i + 2) as '->' | '<-' | '--', col })
      i += 2
    } else if ('(),[]='.includes(c)) {
      tokens.push({ t: 'punct', v: c as '(' | ')' | ',' | '[' | ']' | '=', col })
      i++
    } else if (WORD.test(c)) {
      const start = i
      while (i < src.length && WORD.test(src[i])) {
        // Stop before an arrow so "api->db" splits into api, ->, db.
        if (src[i] === '-' && (src[i + 1] === '>' || src[i + 1] === '-') && i > start) break
        i++
      }
      tokens.push({ t: 'word', v: src.slice(start, i), col })
    } else {
      throw new DslError(line, col, `unexpected character "${c}"`)
    }
  }
  return tokens
}
