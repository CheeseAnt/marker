import type { Board, BoardElement, Id, InstanceElement, Override, TemplateKey, TemplateSpec } from '../model/types'

/** Instances can nest, but not without limit; a cycle is caught before this is reached. */
export const MAX_NESTING = 8

/** Separates an instance id from a child id in compiled (Excalidraw) ids: "web1/box". */
export const CHILD_SEPARATOR = '/'

export function childId(instanceId: Id, child: string): string {
  return `${instanceId}${CHILD_SEPARATOR}${child}`
}

/** The instance a compiled id belongs to, or undefined for top-level elements. */
export function ownerInstance(compiledId: string): { instance: Id; child: string } | undefined {
  const at = compiledId.indexOf(CHILD_SEPARATOR)
  return at < 0 ? undefined : { instance: compiledId.slice(0, at), child: compiledId.slice(at + 1) }
}

export function definitionOf(root: Board, key: TemplateKey): Board | undefined {
  return root.definitions[key]
}

export function specOf(root: Board, key: TemplateKey): TemplateSpec | undefined {
  return root.definitions[key]?.template
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Fills `{param}` placeholders; unknown names are left as written. */
export function fillParams(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (name in values ? values[name] : whole))
}

/** Placeholder names used in a template's text. */
export function placeholdersIn(board: Board): Set<string> {
  const names = new Set<string>()
  for (const el of board.elements) {
    const text = el.kind === 'node' ? el.label : el.kind === 'text' ? el.text : el.kind === 'edge' ? el.label : undefined
    for (const m of text?.matchAll(PLACEHOLDER) ?? []) names.add(m[1])
  }
  return names
}

function withText(el: BoardElement, text: string): BoardElement {
  if (el.kind === 'node' || el.kind === 'edge') return { ...el, label: text }
  if (el.kind === 'text') return { ...el, text }
  return el
}

function textOf(el: BoardElement): string | undefined {
  return el.kind === 'node' || el.kind === 'edge' ? el.label : el.kind === 'text' ? el.text : undefined
}

/**
 * The board an instance shows: its template with params filled in and its overrides applied.
 * Nested instances keep resolving against `root`'s definitions; overrides addressed to their
 * children ("disk/box") are passed down to them.
 */
export function instanceContent(root: Board, inst: InstanceElement): Board | undefined {
  const def = definitionOf(root, inst.template)
  if (!def) return undefined
  const values: Record<string, string> = {}
  for (const p of def.template?.params ?? []) values[p.name] = inst.params[p.name] ?? p.default

  const nested = new Map<Id, Record<string, Override>>()
  for (const [path, o] of Object.entries(inst.overrides)) {
    const owner = ownerInstance(path)
    if (!owner) continue
    const list = nested.get(owner.instance) ?? {}
    list[owner.child] = o
    nested.set(owner.instance, list)
  }

  const elements = def.elements.map((el) => {
    let next = el
    const text = textOf(el)
    if (text !== undefined) next = withText(next, fillParams(text, values))
    const o = inst.overrides[el.id]
    if (o?.text !== undefined) next = withText(next, o.text)
    if (o?.style) next = { ...next, style: { ...next.style, ...o.style } }
    const down = nested.get(el.id)
    if (down && next.kind === 'instance') next = { ...next, overrides: { ...next.overrides, ...down } }
    return next
  })
  return { ...def, elements, definitions: root.definitions, template: undefined }
}

/** Template keys reachable from the board's elements, including through other templates. */
export function usedDefinitions(board: Board): Set<TemplateKey> {
  const used = new Set<TemplateKey>()
  const visit = (elements: BoardElement[]) => {
    for (const el of elements) {
      if (el.kind !== 'instance' || used.has(el.template)) continue
      used.add(el.template)
      const def = board.definitions[el.template]
      if (def) visit(def.elements)
    }
  }
  visit(board.elements)
  return used
}

/** A definition cycle reachable from `key`, as the chain of keys, or undefined. */
export function definitionCycle(board: Board, key: TemplateKey): TemplateKey[] | undefined {
  const walk = (k: TemplateKey, path: TemplateKey[]): TemplateKey[] | undefined => {
    if (path.includes(k)) return [...path, k]
    const def = board.definitions[k]
    if (!def) return undefined
    for (const el of def.elements) {
      if (el.kind !== 'instance') continue
      const found = walk(el.template, [...path, k])
      if (found) return found
    }
    return undefined
  }
  return walk(key, [])
}
