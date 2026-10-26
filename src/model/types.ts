import { z } from 'zod'
import { FONT_IDS } from './fonts'

// Ids are plain identifiers. Elements drawn by hand in Excalidraw keep Excalidraw's own id.
export const idSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'ids must be identifiers')
export type Id = z.infer<typeof idSchema>

export const pointSchema = z.object({ x: z.number(), y: z.number() })
export type Point = z.infer<typeof pointSchema>

export const sizeSchema = z.object({ w: z.number().positive(), h: z.number().positive() })
export type Size = z.infer<typeof sizeSchema>

export const directions = ['below', 'above', 'left', 'right'] as const
export type Direction = (typeof directions)[number]

export const placementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), x: z.number(), y: z.number() }),
  z.object({
    kind: z.literal('rel'),
    dir: z.enum(directions),
    of: idSchema,
    gap: z.number().min(0),
  }),
])
export type Placement = z.infer<typeof placementSchema>

export const styleSchema = z
  .object({
    fill: z.string(),
    stroke: z.string(),
    width: z.number().positive(),
    line: z.enum(['solid', 'dashed', 'dotted']),
    rough: z.number().int().min(0).max(2),
    pattern: z.enum(['hachure', 'solid', 'cross', 'zigzag']),
    opacity: z.number().min(0).max(100),
    font: z.enum(FONT_IDS),
    fontSize: z.number().positive(),
    align: z.enum(['left', 'center', 'right']),
  })
  .partial()
export type Style = z.infer<typeof styleSchema>
export type StyleKey = keyof Style

// Renderer-only details (seed, angle, roundness, ...) that the LLM can ignore.
export const hintsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
export type Hints = z.infer<typeof hintsSchema>

export const shapes = ['rect', 'ellipse', 'diamond', 'sticky'] as const
export type Shape = (typeof shapes)[number]

export const endpointSchema = z.union([
  z.object({ id: idSchema, port: idSchema.optional() }),
  z.object({ point: pointSchema }),
])
export type Endpoint = z.infer<typeof endpointSchema>

export const heads = ['->', '<-', '<->', '--'] as const
export type Head = (typeof heads)[number]

const base = {
  id: idSchema,
  style: styleSchema.default({}),
  hints: hintsSchema.default({}),
}

export const nodeSchema = z.object({
  ...base,
  kind: z.literal('node'),
  label: z.string().default(''),
  shape: z.enum(shapes).default('rect'),
  at: placementSchema.optional(),
  size: sizeSchema.optional(),
})

export const edgeSchema = z.object({
  ...base,
  kind: z.literal('edge'),
  from: endpointSchema,
  to: endpointSchema,
  head: z.enum(heads).default('->'),
  label: z.string().optional(),
  via: z.array(pointSchema).optional(),
})

export const textSchema = z.object({
  ...base,
  kind: z.literal('text'),
  text: z.string(),
  at: placementSchema.optional(),
})

export const groupSchema = z.object({
  ...base,
  kind: z.literal('group'),
  label: z.string().optional(),
  members: z.array(idSchema),
})

export const imageSchema = z.object({
  ...base,
  kind: z.literal('image'),
  asset: z.string().min(1),
  at: placementSchema,
  size: sizeSchema,
})

export const drawSchema = z.object({
  ...base,
  kind: z.literal('draw'),
  at: pointSchema,
  // SVG path data relative to `at`.
  path: z.string().min(1),
})

/** `name@version`, e.g. server@3. */
export const templateKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*@\d+$/, 'template keys look like name@3')
export type TemplateKey = z.infer<typeof templateKeySchema>

/** Per-child changes on one instance, keyed by the child's id inside the template (nested: "disk/box"). */
export const overrideSchema = z.object({ text: z.string().optional(), style: styleSchema.optional() })
export type Override = z.infer<typeof overrideSchema>

export const instanceSchema = z.object({
  ...base,
  kind: z.literal('instance'),
  template: templateKeySchema,
  params: z.record(z.string(), z.string()).default({}),
  at: placementSchema.optional(),
  scale: z.number().positive().optional(),
  overrides: z.record(z.string(), overrideSchema).default({}),
})

export const elementSchema = z.discriminatedUnion('kind', [
  nodeSchema,
  edgeSchema,
  textSchema,
  groupSchema,
  imageSchema,
  drawSchema,
  instanceSchema,
])

export type NodeElement = z.infer<typeof nodeSchema>
export type EdgeElement = z.infer<typeof edgeSchema>
export type TextElement = z.infer<typeof textSchema>
export type GroupElement = z.infer<typeof groupSchema>
export type ImageElement = z.infer<typeof imageSchema>
export type DrawElement = z.infer<typeof drawSchema>
export type InstanceElement = z.infer<typeof instanceSchema>
export type BoardElement = z.infer<typeof elementSchema>
export type ElementKind = BoardElement['kind']

export const FORMAT_VERSION = 1

export const portSides = ['left', 'right', 'top', 'bottom', 'center'] as const
export type PortSide = (typeof portSides)[number]

export interface TemplateParam {
  name: string
  default: string
}

export interface TemplatePort {
  name: string
  /** The element inside the template that edges attach to. */
  target: Id
  side: PortSide
}

/** Makes a board usable as a template: the values a copy can fill in and where edges attach. */
export interface TemplateSpec {
  name: string
  description: string
  params: TemplateParam[]
  ports: TemplatePort[]
}

export const templateSpecSchema = z.object({
  name: idSchema,
  description: z.string().default(''),
  params: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), default: z.string().default('') })).default([]),
  ports: z.array(z.object({ name: idSchema, target: idSchema, side: z.enum(portSides).default('center') })).default([]),
})

/** A template's board as embedded in another board: flat, so it has no definitions of its own. */
export const definitionSchema = z.object({
  title: z.string(),
  formatVersion: z.number().int().positive(),
  defaults: styleSchema.default({}),
  elements: z.array(elementSchema),
  template: templateSpecSchema,
  definitions: z.record(templateKeySchema, z.never()).default({}),
})

export interface Board {
  title: string
  formatVersion: number
  defaults: Style
  // Z-order, bottom first. Groups render nothing, so their position only matters for printing.
  elements: BoardElement[]
  template?: TemplateSpec
  /**
   * Every template version this board uses, directly or through other templates, so the file
   * stands alone. Definitions are flat: a definition's board has none of its own.
   */
  definitions: Record<TemplateKey, Board>
}

export function emptyBoard(title = 'Untitled'): Board {
  return { title, formatVersion: FORMAT_VERSION, defaults: {}, elements: [], definitions: {} }
}

export function templateKey(name: string, version: number): TemplateKey {
  return `${name}@${version}`
}

export function parseTemplateKey(key: TemplateKey): { name: string; version: number } {
  const at = key.lastIndexOf('@')
  return { name: key.slice(0, at), version: Number(key.slice(at + 1)) }
}

export function findElement(board: Board, id: Id): BoardElement | undefined {
  return board.elements.find((e) => e.id === id)
}

export function isBoxed(el: BoardElement): el is NodeElement | TextElement | ImageElement | InstanceElement {
  return el.kind === 'node' || el.kind === 'text' || el.kind === 'image' || el.kind === 'instance'
}

/** Elements that have a placement (`at`): they can be placed relative to others and anchor them. */
export function isPlaceable(el: BoardElement): el is NodeElement | TextElement | ImageElement | InstanceElement {
  return isBoxed(el)
}
