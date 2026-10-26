import { z } from 'zod'
import { placeUnplaced } from '../compile/layout'
import { undo as undoStep, type History } from '../history/history'
import { commit, OpError } from '../model/apply'
import type { Op } from '../model/ops'
import type { Board, Id } from '../model/types'
import type { TemplateVersion } from '../templates/operations'
import { editArgsSchema, replyArgsSchema, toCoreOps } from './llmOps'
import { buildContext, SYSTEM_PROMPT, type Attachment } from './prompt'
import { ProviderError, type ChatMessage, type LLMProvider, type ToolCall, type ToolDef, type Usage } from './providers/types'

export const MAX_REPAIRS = 2
export const UNDO_MOVED = "Another change landed after this request was sent, so nothing was undone. Open History to go back to the change you meant."

const MAX_OUTPUT_TOKENS = 8000

export const TOOLS: ToolDef[] = [
  {
    name: 'edit_board',
    description: 'Apply changes to the board. Include every change for the request in one call.',
    parameters: z.toJSONSchema(editArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'reply',
    description: 'Answer without changing the board: for questions, or when the request is too unclear to act on.',
    parameters: z.toJSONSchema(replyArgsSchema) as Record<string, unknown>,
  },
]

export type EditStage = 'thinking' | 'repairing' | 'placing'

/** Transactions to undo before applying, newest first, so the caller can check they are still the newest. */
export interface UndoPlan {
  txIds: string[]
}

export type EditResult =
  | { kind: 'edit'; undo: UndoPlan; ops: Op[]; title: string; changedIds: Id[]; usage: Usage; repairs: number }
  | { kind: 'reply'; message: string; usage: Usage; repairs: number }

export interface EditRequest {
  prompt: string
  provider: LLMProvider
  /** Read at the start and again before validating, so the result fits the latest board. */
  getBoard: () => Board
  /** For undo_first; read together with getBoard. */
  getHistory: () => History
  /**
   * The ids of the newest changes when the request was sent, newest first: what the model was
   * shown as "Recent changes". undo_first undoes these, and only while they are still the newest.
   */
  undoBase?: string[]
  selection: Id[]
  /** Formatted recent conversation and changes (see formatRecent). */
  recent?: string
  /** Library templates the model may add (latest version of each). */
  templates?: TemplateVersion[]
  /** Images sent with the request; the model can see them and place them with add_image. */
  attachments?: Attachment[]
  /** The visible part of the board when the request was made. */
  viewport?: { x: number; y: number; w: number; h: number }
  signal?: AbortSignal
  onStage?: (stage: EditStage, detail: { outputTokens: number; repair: number }) => void
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...((a.cachedInputTokens || b.cachedInputTokens) && { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }),
  }
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
}

/** Ids an op set adds or changes, for highlighting the result. */
function touchedIds(ops: Op[]): Id[] {
  const ids = new Set<Id>()
  for (const o of ops) {
    if (o.op === 'add' || o.op === 'replace') ids.add(o.element.id)
    else if (o.op === 'update' || o.op === 'reorder') ids.add(o.id)
  }
  return [...ids]
}

/**
 * Turns a request into board ops: asks the model, validates its tool call against the current
 * board, sends problems back for up to MAX_REPAIRS rounds, then lays out new nodes.
 */
export async function runEdit(req: EditRequest): Promise<EditResult> {
  const attachments = req.attachments ?? []
  if (attachments.length && !req.provider.capabilities.vision) {
    throw new ProviderError('config', `${req.provider.label} can't look at images. Remove the attachments, or choose a model that can.`)
  }
  const context = buildContext(
    { board: req.getBoard(), selection: req.selection, recent: req.recent, templates: req.templates, attachments, viewport: req.viewport },
    req.prompt,
  )
  const center = req.viewport && req.viewport.w > 0 ? { x: req.viewport.x + req.viewport.w / 2, y: req.viewport.y + req.viewport.h / 2 } : undefined
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: attachments.length
        ? [{ type: 'text', text: context }, ...attachments.map((a) => ({ type: 'image' as const, dataUrl: a.dataURL }))]
        : context,
    },
  ]
  const images = new Map(attachments.map((a) => [a.assetId, { width: a.width, height: a.height }]))
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }

  for (let repair = 0; ; repair++) {
    req.onStage?.(repair ? 'repairing' : 'thinking', { outputTokens: 0, repair })
    const result = await req.provider.complete(
      { system: SYSTEM_PROMPT, messages, tools: TOOLS, toolChoice: 'required', maxOutputTokens: MAX_OUTPUT_TOKENS },
      { signal: req.signal, onProgress: (p) => req.onStage?.(repair ? 'repairing' : 'thinking', { outputTokens: p.outputTokens, repair }) },
    )
    usage = addUsage(usage, result.usage)
    const call: ToolCall | undefined = result.toolCalls[0]

    const problems = (issues: string[]) => {
      if (repair >= MAX_REPAIRS) {
        throw new ProviderError('bad-request', `The model's changes didn't fit the board after ${MAX_REPAIRS} corrections: ${issues[0]}`)
      }
      messages.push({ role: 'assistant', content: result.text || null, ...(call && { toolCalls: [call] }) })
      const text = `Those changes could not be applied:\n- ${issues.join('\n- ')}\nCall edit_board again with corrected ops for the whole request.`
      if (call) messages.push({ role: 'tool', toolCallId: call.id, content: text })
      else messages.push({ role: 'user', content: text })
    }

    if (!call) {
      if (result.text.trim()) return { kind: 'reply', message: result.text.trim(), usage, repairs: repair }
      problems(['no tool was called'])
      continue
    }

    let args: unknown
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      problems([`the ${call.name} arguments were not valid JSON`])
      continue
    }

    if (call.name === 'reply') {
      const parsed = replyArgsSchema.safeParse(args)
      if (parsed.success) return { kind: 'reply', message: parsed.data.message, usage, repairs: repair }
      problems(zodIssues(parsed.error))
      continue
    }
    if (call.name !== 'edit_board') {
      problems([`unknown tool "${call.name}"; use edit_board or reply`])
      continue
    }

    const parsed = editArgsSchema.safeParse(args)
    if (!parsed.success) {
      problems(zodIssues(parsed.error))
      continue
    }
    // Undo first, on a copy: the ops must fit the board as it will be after the undo.
    const undoCount = parsed.data.undo_first ?? 0
    let board = req.getBoard()
    let history = req.getHistory()
    const newest = history.past.slice(history.past.length - undoCount).map((t) => t.id).reverse()
    const undoable = req.undoBase ? req.undoBase.length : history.past.length
    if (undoCount > undoable || undoCount > history.past.length) {
      problems([`undo_first is ${undoCount} but only ${Math.min(undoable, history.past.length)} change(s) can be undone`])
      continue
    }
    const txIds = req.undoBase ? req.undoBase.slice(0, undoCount) : newest
    // Another change landed since the request was sent: undoing the newest would undo that one.
    if (txIds.some((id, i) => id !== newest[i])) throw new ProviderError('bad-request', UNDO_MOVED)
    try {
      for (let i = 0; i < undoCount; i++) ({ board, history } = undoStep(board, history)!)
    } catch (e) {
      if (!(e instanceof OpError)) throw e
      throw new ProviderError('bad-request', `Couldn't undo the last ${undoCount === 1 ? 'change' : `${undoCount} changes`}: ${e.issues[0]}`)
    }
    const { ops, issues } = toCoreOps(board, parsed.data.ops, { templates: req.templates ?? [], images, anchor: req.selection[0], center })
    if (issues.length) {
      problems(issues)
      continue
    }
    let applied: Board
    try {
      applied = commit(board, ops).board
    } catch (e) {
      if (e instanceof OpError) {
        problems(e.issues)
        continue
      }
      throw e
    }

    req.onStage?.('placing', { outputTokens: usage.outputTokens, repair })
    const layout = ops.length ? await placeUnplaced(applied, { center }) : []
    const all = [...ops, ...layout]
    return { kind: 'edit', undo: { txIds }, ops: all, title: parsed.data.summary, changedIds: touchedIds(all), usage, repairs: repair }
  }
}
