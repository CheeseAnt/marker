import { z } from 'zod'
import { elementSchema, idSchema, styleSchema, type BoardElement, type Id } from './types'

/**
 * Core ops. Every change, from manual edits, the LLM, or undo, is a list of these.
 * `update.set` replaces top-level fields; `style` and `hints` are merged instead.
 * A null value removes an optional field (or a style or hint key).
 * `after` positions an element in z-order: null is the bottom, omitted on add is the top.
 * `replace` swaps an element for another with the same id (even of another kind) without
 * the cascades a remove would trigger. `board` changes the title or default style.
 */
export const opSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), element: elementSchema, after: idSchema.nullable().optional() }),
  z.object({ op: z.literal('update'), id: idSchema, set: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('remove'), id: idSchema }),
  z.object({ op: z.literal('reorder'), id: idSchema, after: idSchema.nullable() }),
  z.object({ op: z.literal('replace'), element: elementSchema }),
  z.object({ op: z.literal('board'), set: z.object({ title: z.string(), defaults: styleSchema }).partial() }),
])
export type Op = z.infer<typeof opSchema>

export type AddOp = Extract<Op, { op: 'add' }>
export type UpdateOp = Extract<Op, { op: 'update' }>

export const MERGED_FIELDS = ['style', 'hints'] as const
export const FIXED_FIELDS = ['id', 'kind'] as const

export function addOp(element: BoardElement, after?: Id | null): AddOp {
  return after === undefined ? { op: 'add', element } : { op: 'add', element, after }
}

export function updateOp(id: Id, set: Record<string, unknown>): UpdateOp {
  return { op: 'update', id, set }
}
