import { create } from 'zustand'
import { runEdit, type EditStage } from '../ai/orchestrator'
import { createProvider } from '../ai/providers'
import type { Attachment } from '../ai/prompt'
import { loadAsset } from '../assets/store'
import { latestVersion, useLibrary } from '../templates/library'
import { formatRecent, RECENT_CHANGES, recentContext, type RecentTurn } from '../ai/recent'
import type { Transaction } from '../history/history'
import { ProviderError, type Usage } from '../ai/providers/types'
import { OpError } from '../model/apply'
import type { Id } from '../model/types'
import { useSettings } from '../settings/store'
import { useBoard, type ChangeSource } from '../state/board'
import { highlightAfterRender, type Viewport } from '../state/canvasBridge'
import { useToast } from '../state/toast'
import { monthStart, since, totals } from '../usage/aggregate'
import { formatUsd } from '../usage/format'
import { useUsage } from '../usage/ledger'
import { meterProvider } from '../usage/meter'

export type JobStage = 'queued' | EditStage | 'done' | 'answered' | 'failed' | 'cancelled'

export interface Job {
  id: string
  prompt: string
  source: Extract<ChangeSource, 'ai' | 'voice'>
  selection: Id[]
  /** Images attached to the request (selected board images are added when it runs). */
  attachments: AttachmentRef[]
  /** What the user was looking at when they asked; new things go there. */
  viewport?: Viewport
  /**
   * The newest changes when the request was sent, oldest first. The model reads them as
   * "Recent changes", so "undo that" means these, even if another request lands meanwhile.
   */
  changesAtSend: Transaction[]
  stage: JobStage
  createdAt: number
  startedAt?: number
  finishedAt?: number
  outputTokens: number
  repair: number
  usage?: Usage
  title?: string
  reply?: string
  error?: string
  txId?: string
  /** Set once the request has been redone because the board changed underneath it. */
  redone?: boolean
  /** The user chose to send it even though the monthly limit was reached. */
  overBudgetOk?: boolean
}

export interface AttachmentRef {
  assetId: string
  label: string
}

export const ACTIVE_STAGES: JobStage[] = ['thinking', 'repairing', 'placing']
/** More images cost more and rarely help a whiteboard edit. */
export const MAX_ATTACHMENTS = 4
const KEEP_FINISHED = 20

interface QueueState {
  jobs: Job[]
  submit: (
    prompt: string,
    opts?: { source?: Job['source']; selection?: Id[]; attachments?: AttachmentRef[]; viewport?: Viewport; overBudgetOk?: boolean },
  ) => string
  cancel: (id: string) => void
  retry: (id: string, opts?: { overBudgetOk?: boolean }) => void
  clearFinished: () => void
  /** Follows elements that were given new ids, so waiting requests still mean them. */
  renameIds: (renamed: Map<Id, Id>) => void
}

const controllers = new Map<string, AbortController>()
let counter = 0

export const useJobs = create<QueueState>((set, get) => {
  const patch = (id: string, changes: Partial<Job>) =>
    set({ jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...changes } : j)) })

  const finish = (id: string, changes: Partial<Job>) => {
    patch(id, { ...changes, finishedAt: Date.now() })
    // Keep the queue short: every unfinished job plus the most recent finished ones.
    const jobs = get().jobs
    const finished = jobs.filter((j) => !isPending(j))
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((j) => j.id))
      set({ jobs: jobs.filter((j) => !drop.has(j.id)) })
    }
    pump()
  }

  /**
   * Starts waiting requests, up to the concurrency setting. Applying is synchronous, so changes
   * still land one at a time; a request whose changes no longer fit is redone once (see run).
   */
  const pump = () => {
    const limit = useSettings.getState().settings.jobConcurrency
    for (;;) {
      const jobs = get().jobs
      const active = jobs.filter((j) => ACTIVE_STAGES.includes(j.stage)).length
      const next = jobs.find((j) => j.stage === 'queued')
      if (!next || active >= limit) return
      void run(next)
    }
  }

  const run = async (job: Job) => {
    const controller = new AbortController()
    controllers.set(job.id, controller)
    const { settings, secrets } = useSettings.getState()
    const over = overBudget(settings.budget.limit)
    if (over && !job.overBudgetOk) {
      useToast.getState().show({
        kind: 'error',
        text: `This month's spending (${formatUsd(over)}) has reached your limit of ${formatUsd(settings.budget.limit)}. Change it in Settings, or send this request anyway.`,
        prompt: job.prompt,
        action: { label: 'Send anyway', run: () => get().retry(job.id, { overBudgetOk: true }) },
      })
      controllers.delete(job.id)
      return finish(job.id, { stage: 'failed', error: 'Not sent: the monthly spending limit is reached.' })
    }
    patch(job.id, { stage: 'thinking', startedAt: Date.now() })
    const provider = meterProvider(createProvider(settings, secrets), { deployment: settings.providers[settings.activeProvider].deployment, jobId: job.id })
    try {
      const attachments = await resolveAttachments(job)
      const result = await runEdit({
        attachments,
        viewport: job.viewport,
        prompt: job.prompt,
        provider,
        getBoard: () => useBoard.getState().board,
        getHistory: () => useBoard.getState().history,
        undoBase: job.changesAtSend.map((t) => t.id).reverse(),
        selection: job.selection,
        recent: formatRecent(recentContext({ past: job.changesAtSend, future: [] }, recentTurns(get().jobs))),
        templates: Object.values(useLibrary.getState().entries).map(latestVersion),
        signal: controller.signal,
        onStage: (stage, { outputTokens, repair }) => patch(job.id, { stage, outputTokens, repair }),
      })
      warnIfOverBudget()
      const usage = sumUsage(get().jobs.find((j) => j.id === job.id)?.usage, result.usage)
      patch(job.id, { usage })
      if (controller.signal.aborted) return finish(job.id, { stage: 'cancelled', usage })
      if (result.kind === 'reply') {
        useToast.getState().show({ kind: 'reply', text: result.message, prompt: job.prompt })
        return finish(job.id, { stage: 'answered', reply: result.message, usage })
      }
      const txId = applyEdit(result.undo.txIds, () =>
        result.ops.length ? useBoard.getState().apply(result.ops, job.source, { title: result.title, prompt: job.prompt })?.id : undefined,
      )
      highlightAfterRender(result.changedIds)
      useToast.getState().show({
        kind: 'done',
        text: result.title,
        ...(txId && {
          action: {
            label: 'Undo',
            run: () => {
              const { history, undo } = useBoard.getState()
              if (history.past.at(-1)?.id === txId) undo()
              // Undoing an older change here would silently undo the newer ones too.
              else useToast.getState().show({ kind: 'error', text: 'Newer changes were made since. Open History to go back to before this one.' })
            },
          },
        }),
      })
      finish(job.id, { stage: 'done', title: result.title, usage, txId })
    } catch (e) {
      if (controller.signal.aborted || (e instanceof ProviderError && e.kind === 'aborted')) return finish(job.id, { stage: 'cancelled' })
      // Another change landed first and this one no longer fits: work it out again, once.
      const current = get().jobs.find((j) => j.id === job.id)
      if (e instanceof ConflictError && !current?.redone) {
        patch(job.id, { stage: 'queued', redone: true, outputTokens: 0, repair: 0 })
        return pump()
      }
      const message = e instanceof ProviderError ? e.message : `Something went wrong: ${(e as Error).message}`
      useToast.getState().show({ kind: 'error', text: message, prompt: job.prompt, action: { label: 'Try again', run: () => get().retry(job.id) } })
      finish(job.id, { stage: 'failed', error: message })
    } finally {
      controllers.delete(job.id)
    }
  }

  return {
    jobs: [],
    session: { inputTokens: 0, outputTokens: 0 },
    submit: (prompt, opts = {}) => {
      const id = `job-${Date.now().toString(36)}-${(counter++).toString(36)}`
      const job: Job = {
        id,
        prompt,
        source: opts.source ?? 'ai',
        selection: opts.selection ?? [],
        attachments: opts.attachments ?? [],
        ...(opts.viewport && { viewport: opts.viewport }),
        ...(opts.overBudgetOk && { overBudgetOk: true }),
        changesAtSend: useBoard.getState().history.past.slice(-RECENT_CHANGES),
        stage: 'queued',
        createdAt: Date.now(),
        outputTokens: 0,
        repair: 0,
      }
      set({ jobs: [...get().jobs, job] })
      pump()
      return id
    },
    cancel: (id) => {
      const job = get().jobs.find((j) => j.id === id)
      if (!job) return
      if (job.stage === 'queued') return finish(id, { stage: 'cancelled' })
      controllers.get(id)?.abort()
    },
    retry: (id, opts = {}) => {
      const job = get().jobs.find((j) => j.id === id)
      if (!job) return
      get().submit(job.prompt, { source: job.source, selection: job.selection, attachments: job.attachments, viewport: job.viewport, overBudgetOk: opts.overBudgetOk })
    },
    clearFinished: () => {
      set({ jobs: get().jobs.filter(isPending) })
    },
    renameIds: (renamed) => {
      set({ jobs: get().jobs.map((j) => (isPending(j) && j.selection.some((id) => renamed.has(id)) ? { ...j, selection: j.selection.map((id) => renamed.get(id) ?? id) } : j)) })
    },
  }
})

/** The job's own images, then selected board images, as data the model can see. */
async function resolveAttachments(job: Job): Promise<Attachment[]> {
  const board = useBoard.getState().board
  const selectedImages: AttachmentRef[] = board.elements
    .filter((e) => e.kind === 'image' && job.selection.includes(e.id))
    .map((e) => ({ assetId: (e as { asset: string }).asset, label: `board image ${e.id}` }))
  const refs = [...job.attachments, ...selectedImages].filter((r, i, all) => all.findIndex((x) => x.assetId === r.assetId) === i)
  const out: Attachment[] = []
  for (const ref of refs.slice(0, MAX_ATTACHMENTS)) {
    const asset = await loadAsset(ref.assetId)
    if (asset) out.push({ assetId: asset.id, label: ref.label, dataURL: asset.dataURL, width: asset.width, height: asset.height })
  }
  return out
}

/** This month's spending, if it has reached `limit` (0 means no limit). */
function overBudget(limit: number): number | undefined {
  if (!limit) return undefined
  const spent = totals(since(useUsage.getState().records, monthStart(Date.now()))).cost
  return spent >= limit ? spent : undefined
}

let warnedMonth = -1
/** Warns once a month when spending passes the warning amount. */
function warnIfOverBudget() {
  const { warnAt } = useSettings.getState().settings.budget
  const month = monthStart(Date.now())
  if (!warnAt || warnedMonth === month) return
  const spent = totals(since(useUsage.getState().records, month)).cost
  if (spent < warnAt) return
  warnedMonth = month
  useToast.getState().show({ kind: 'reply', text: `This month's spending has passed ${formatUsd(warnAt)}: ${formatUsd(spent)} so far.` })
}

const CHANGED_WHILE_RUNNING = 'The board changed while this request was running, so its changes no longer fit. Try it again.'

/** The board moved on while a request was being worked out; the queue redoes it once. */
export class ConflictError extends ProviderError {
  constructor() {
    super('bad-request', CHANGED_WHILE_RUNNING)
  }
}

function sumUsage(a: Usage | undefined, b: Usage): Usage {
  return a ? { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens } : b
}

/**
 * Undoes `undoIds` (newest first) and then runs `apply`, as one unit: if the history no longer
 * ends with those changes, nothing happens; if applying fails, the undone changes are redone.
 */
function applyEdit(undoIds: string[], apply: () => string | undefined): string | undefined {
  const board = useBoard.getState()
  const newest = board.history.past.slice(board.history.past.length - undoIds.length).map((t) => t.id).reverse()
  if (newest.length !== undoIds.length || newest.some((id, i) => id !== undoIds[i])) throw new ConflictError()
  undoIds.forEach(() => useBoard.getState().undo())
  try {
    return apply()
  } catch (e) {
    undoIds.forEach(() => useBoard.getState().redo())
    if (e instanceof OpError) throw new ConflictError()
    throw e
  }
}

/** Finished requests, oldest first, as the model should remember them. */
export function recentTurns(jobs: Job[]): RecentTurn[] {
  return jobs.flatMap((j): RecentTurn[] => {
    const ts = j.finishedAt ?? j.createdAt
    switch (j.stage) {
      case 'done':
        return [{ prompt: j.prompt, ts, outcome: { kind: 'edit', title: j.title ?? '' } }]
      case 'answered':
        return [{ prompt: j.prompt, ts, outcome: { kind: 'reply', message: j.reply ?? '' } }]
      case 'failed':
        return [{ prompt: j.prompt, ts, outcome: { kind: 'failed', error: j.error ?? '' } }]
      case 'cancelled':
        return [{ prompt: j.prompt, ts, outcome: { kind: 'cancelled' } }]
      default:
        return []
    }
  })
}

export function isPending(job: Job): boolean {
  return job.stage === 'queued' || ACTIVE_STAGES.includes(job.stage)
}
