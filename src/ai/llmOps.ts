import { z } from 'zod'
import { FONT_IDS, withBoardFont } from '../model/fonts'
import type { Op } from '../model/ops'
import {
  heads,
  idSchema,
  shapes,
  styleSchema,
  type Board,
  type BoardElement,
  type Placement,
} from '../model/types'

/**
 * The edit vocabulary the model uses. It is friendlier than the core ops (named actions,
 * relative placement, optional edge ids) and is translated into core ops before applying.
 */

const placeSchema = z
  .union([
    z.object({
      rel: z.enum(['below', 'above', 'left', 'right']),
      of: idSchema.describe('Id of the element to place relative to.'),
      gap: z.number().min(0).optional().describe('Distance in px. Default 60.'),
    }),
    z.object({ x: z.number(), y: z.number() }).describe('Absolute top-left position. Prefer relative placement.'),
  ])
  .describe('Where to put the element. Omit to let BoardBot lay it out next to what it connects to.')

const sizeSchema = z.object({ w: z.number().positive(), h: z.number().positive() })

const style = styleSchema.describe(
  'Visual style. Colours are hex like #1971c2. fill is the background, stroke the outline and text colour.',
)

const shape = z.enum(shapes).describe('rect, ellipse, diamond, or sticky (a sticky note).')

export const llmOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_node'),
    id: idSchema.describe('Short, meaningful, unique id such as "api" or "cache".'),
    label: z.string(),
    shape: shape.optional(),
    place: placeSchema.optional(),
    size: sizeSchema.optional().describe('Omit to size the node to its label.'),
    style: style.optional(),
  }),
  z.object({
    op: z.literal('add_text'),
    id: idSchema,
    text: z.string(),
    place: placeSchema.optional(),
    style: style.optional(),
  }),
  z.object({
    op: z.literal('add_edge'),
    id: idSchema.optional().describe('Omit to generate one.'),
    from: idSchema,
    to: idSchema,
    label: z.string().optional(),
    head: z.enum(heads).optional().describe('-> (default), <-, <-> or -- for no arrowheads.'),
    style: style.optional(),
  }),
  z.object({
    op: z.literal('add_drawing'),
    id: idSchema,
    at: z.object({ x: z.number(), y: z.number() }),
    path: z.string().describe('SVG path data (M, L, H, V, Q, C, Z) relative to "at". Use for simple icons and doodles.'),
    style: style.optional(),
  }),
  z.object({
    op: z.literal('update'),
    id: idSchema,
    label: z.string().optional().describe('New label (nodes, edges, groups) or text (text elements).'),
    shape: shape.optional(),
    place: placeSchema.optional(),
    size: sizeSchema.optional(),
    style: style.optional().describe('Only the style keys to change.'),
    from: idSchema.optional(),
    to: idSchema.optional(),
    head: z.enum(heads).optional(),
  }),
  z.object({ op: z.literal('remove'), id: idSchema.describe('Removing a node also removes its edges.') }),
  z.object({ op: z.literal('group'), id: idSchema, members: z.array(idSchema).min(1), label: z.string().optional() }),
  z.object({ op: z.literal('ungroup'), id: idSchema.describe('The group to dissolve; its members stay.') }),
  z.object({ op: z.literal('reorder'), id: idSchema, to: z.enum(['front', 'back']) }),
  z.object({ op: z.literal('set_board_font'), font: z.enum(FONT_IDS).describe('The font for every element without its own font.') }),
])
export type LlmOp = z.infer<typeof llmOpSchema>

export const MAX_UNDO_FIRST = 5

export const editArgsSchema = z
  .object({
    summary: z.string().min(1).max(120).describe('What you changed, past tense, under 60 characters, e.g. "Added a cache below the API".'),
    undo_first: z
      .number()
      .int()
      .min(0)
      .max(MAX_UNDO_FIRST)
      .optional()
      .describe(
        'Undo this many of the most recent changes (see "Recent changes") before applying ops. Use it when the user asks to undo something, or to undo and redo it differently. Ops then apply to the board as it was before those changes.',
      ),
    ops: z.array(llmOpSchema).describe('May be empty only when undo_first is set.'),
  })
  .refine((a) => a.ops.length > 0 || (a.undo_first ?? 0) > 0, { message: 'give at least one op, or set undo_first', path: ['ops'] })
export type EditArgs = z.infer<typeof editArgsSchema>

export const replyArgsSchema = z.object({
  message: z.string().min(1).describe('A short answer, or the question you need answered before you can edit.'),
})

function toPlacement(place: z.infer<typeof placeSchema>): Placement {
  return 'rel' in place
    ? { kind: 'rel', dir: place.rel, of: place.of, gap: place.gap ?? 60 }
    : { kind: 'at', x: place.x, y: place.y }
}

/**
 * Translates model ops into core ops against `board`. Problems the model can fix are returned
 * as `issues` (written for the model) rather than thrown.
 */
export function toCoreOps(board: Board, llmOps: LlmOp[]): { ops: Op[]; issues: string[] } {
  const ops: Op[] = []
  const issues: string[] = []
  // Elements as they will be once earlier ops in this batch apply, for kind checks.
  const known = new Map<string, BoardElement['kind']>(board.elements.map((e) => [e.id, e.kind]))
  const used = new Set(known.keys())
  const fresh = (base: string) => {
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`
    used.add(id)
    return id
  }
  const empty = { style: {}, hints: {} }

  llmOps.forEach((o, i) => {
    const at = `ops[${i}] (${o.op}${'id' in o && o.id ? ` "${o.id}"` : ''})`
    switch (o.op) {
      case 'add_node':
        used.add(o.id)
        known.set(o.id, 'node')
        ops.push({
          op: 'add',
          element: {
            ...empty,
            kind: 'node',
            id: o.id,
            label: o.label,
            shape: o.shape ?? 'rect',
            ...(o.place && { at: toPlacement(o.place) }),
            ...(o.size && { size: o.size }),
            style: o.style ?? {},
          },
        })
        break
      case 'add_text':
        used.add(o.id)
        known.set(o.id, 'text')
        ops.push({ op: 'add', element: { ...empty, kind: 'text', id: o.id, text: o.text, ...(o.place && { at: toPlacement(o.place) }), style: o.style ?? {} } })
        break
      case 'add_edge': {
        const id = o.id && !used.has(o.id) ? (used.add(o.id), o.id) : fresh(`${o.from}_${o.to}`)
        known.set(id, 'edge')
        ops.push({
          op: 'add',
          element: {
            ...empty,
            kind: 'edge',
            id,
            from: { id: o.from },
            to: { id: o.to },
            head: o.head ?? '->',
            ...(o.label && { label: o.label }),
            style: o.style ?? {},
          },
        })
        break
      }
      case 'add_drawing':
        used.add(o.id)
        known.set(o.id, 'draw')
        ops.push({ op: 'add', element: { ...empty, kind: 'draw', id: o.id, at: o.at, path: o.path, style: o.style ?? {} } })
        break
      case 'update': {
        const kind = known.get(o.id)
        if (!kind) {
          issues.push(`${at}: there is no element "${o.id}"`)
          break
        }
        const set: Record<string, unknown> = {}
        if (o.label !== undefined) set[kind === 'text' ? 'text' : 'label'] = o.label
        if (o.shape) {
          if (kind === 'node') set.shape = o.shape
          else issues.push(`${at}: only nodes have a shape`)
        }
        if (o.place) {
          if (kind === 'node' || kind === 'text' || kind === 'image') set.at = toPlacement(o.place)
          else if (kind === 'draw' && !('rel' in o.place)) set.at = { x: o.place.x, y: o.place.y }
          else issues.push(`${at}: a ${kind} can't be placed that way`)
        }
        if (o.size) set.size = o.size
        if (o.style) set.style = o.style
        for (const key of ['from', 'to'] as const) {
          if (o[key] === undefined) continue
          if (kind === 'edge') set[key] = { id: o[key] }
          else issues.push(`${at}: only edges have "${key}"`)
        }
        if (o.head) {
          if (kind === 'edge') set.head = o.head
          else issues.push(`${at}: only edges have arrowheads`)
        }
        if (Object.keys(set).length === 0) issues.push(`${at}: nothing to change`)
        else ops.push({ op: 'update', id: o.id, set })
        break
      }
      case 'remove':
        ops.push({ op: 'remove', id: o.id })
        known.delete(o.id)
        break
      case 'group':
        used.add(o.id)
        known.set(o.id, 'group')
        ops.push({ op: 'add', element: { ...empty, kind: 'group', id: o.id, members: o.members, ...(o.label && { label: o.label }) } })
        break
      case 'ungroup':
        if (known.get(o.id) !== 'group') issues.push(`${at}: "${o.id}" is not a group`)
        else {
          ops.push({ op: 'remove', id: o.id })
          known.delete(o.id)
        }
        break
      case 'set_board_font': {
        ops.push({ op: 'board', set: { defaults: withBoardFont(board.defaults, o.font) } })
        break
      }
      case 'reorder': {
        const top = [...board.elements].reverse().find((e) => e.id !== o.id)?.id ?? null
        ops.push({ op: 'reorder', id: o.id, after: o.to === 'back' ? null : top })
        break
      }
    }
  })
  return { ops, issues }
}
