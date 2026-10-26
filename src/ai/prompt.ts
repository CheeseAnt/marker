import { printBoard, printElement } from '../dsl/print'
import { FONT_PRESETS } from '../model/fonts'
import type { Board, Id } from '../model/types'

/** Above this size only the selection and its neighbourhood are sent in full. */
export const FULL_BOARD_CHAR_LIMIT = 24_000
const SUMMARY_CHAR_LIMIT = 8_000

export const SYSTEM_PROMPT = `You edit a hand-drawn whiteboard for the user. The board is described in a small text format, one element per line:

  node <id> "<label>" <rect|ellipse|diamond|sticky> [at(x,y) | below(<id>,gap) | above(..) | left(..) | right(..)] [size(w,h)] [style]
  edge <id> <from> -> <to> ["label"] [dashed|dotted] [style]     (heads: ->, <-, <->, --)
  text <id> "<text>" [placement] [style]
  group <id> ["label"] [member, member, ...]
  draw <id> at(x,y) path="<svg path>"
  image <id> asset:<id> at(x,y) size(w,h)

Style keys: fill, stroke, width (1|2|4), line (solid|dashed|dotted), rough (0 neat, 1 normal, 2 sketchy), pattern (hachure|solid|cross|zigzag), opacity (0-100), font, fontSize, align.
Fonts: ${FONT_PRESETS.map((f) => `${f.id} (${f.note})`).join(', ')}. A \`style default font=...\` line sets the board font (change it with set_board_font, only when asked about the whole board); an element's own font overrides it. Coordinates are pixels, x to the right, y downwards. A typical node is 160x80.

How to edit:
- Make every change by calling edit_board once with all the ops. Never describe changes in prose instead.
- Change only what the request asks for. Keep existing ids; refer to elements by their ids.
- Place new nodes relative to existing ones (place: {rel, of}) or leave place out and BoardBot lays them out next to what they connect to. Use absolute x,y only when the user asks for a position.
- Connect related nodes with add_edge; removing a node removes its edges too.
- "This", "it" and "these" usually mean the selected elements. "That", "again" or "the last one" can also mean the most recent change or answer; check the recent conversation and changes.
- When the user agrees to something you suggested ("yes", "do that"), carry out what you proposed in your last reply.
- To undo, or to undo something and do it another way, set undo_first to how many of the newest changes to undo, and give the replacement ops (or none for a plain undo).
- Good colours on a whiteboard: fills #a5d8ff (blue), #b2f2bb (green), #ffec99 (yellow), #ffc9c9 (red), #d0bfff (violet), #eebefa (pink); strokes #1e1e1e, #1971c2, #2f9e44, #e03131, #f08c00.
- For a request that asks a question instead of a change, or is too unclear to act on, call reply.`

export interface ContextInput {
  board: Board
  selection: Id[]
  /** Recent conversation and changes, already formatted (see formatRecent). */
  recent?: string
}

/** Neighbours of `ids`: elements they connect to, group with, or are placed relative to. */
function neighbourhood(board: Board, ids: Set<Id>): Set<Id> {
  const out = new Set(ids)
  for (const el of board.elements) {
    if (el.kind === 'edge') {
      const ends = [el.from, el.to].flatMap((e) => ('id' in e ? [e.id] : []))
      if (ends.some((e) => ids.has(e)) || ids.has(el.id)) {
        out.add(el.id)
        ends.forEach((e) => out.add(e))
      }
    } else if (el.kind === 'group' && el.members.some((m) => ids.has(m))) {
      out.add(el.id)
    } else if ('at' in el && el.at && 'kind' in el.at && el.at.kind === 'rel' && (ids.has(el.id) || ids.has(el.at.of))) {
      out.add(el.id)
      out.add(el.at.of)
    }
  }
  return out
}

/** The user message for a request: the board (or the relevant part of it), the selection and the request. */
export function buildContext({ board, selection, recent }: ContextInput, request: string): string {
  const full = printBoard(board, { hints: false })
  let boardText = full
  if (full.length > FULL_BOARD_CHAR_LIMIT) {
    const focus = neighbourhood(board, new Set(selection))
    const shown = board.elements.filter((e) => focus.has(e.id))
    const others = board.elements.filter((e) => !focus.has(e.id))
    const summary: string[] = []
    let length = 0
    for (const e of others) {
      const item = `${e.id} (${e.kind}${e.kind === 'node' && e.label ? ` "${e.label.slice(0, 24)}"` : ''})`
      if (length + item.length > SUMMARY_CHAR_LIMIT) {
        summary.push(`and ${others.length - summary.length} more`)
        break
      }
      summary.push(item)
      length += item.length + 2
    }
    boardText = [
      `board "${board.title}" (large; showing the selection and its neighbours in full)`,
      ...shown.map((e) => printElement(e, { hints: false })),
      '',
      `Other elements, by id and kind: ${summary.join(', ')}`,
    ].join('\n')
  }
  const selected = selection.length ? `Selected: ${selection.join(', ')}` : 'Nothing is selected.'
  const history = recent ? `${recent}\n\n` : ''
  return `${history}Current board:\n\`\`\`\n${boardText.trimEnd()}\n\`\`\`\n${selected}\n\nRequest: ${request}`
}
