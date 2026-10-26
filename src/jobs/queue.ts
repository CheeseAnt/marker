import { create } from 'zustand'
import { runEdit, type EditStage } from '../ai/orchestrator'
import { createProvider } from '../ai/providers'
import { latestVersion, useLibrary } from '../templates/library'
import { formatRecent, recentContext, type RecentTurn } from '../ai/recent'
import { ProviderError, type Usage } from '../ai/providers/types'
import { OpError } from '../model/apply'
import type { Id } from '../model/types'
import { useSettings } from '../settings/store'
import { useBoard, type ChangeSource } from '../state/board'
import { highlightAfterRender } from '../state/canvasBridge'
import { useToast } from '../state/toast'

export type JobStage = 'queued' | EditStage | 'done' | 'answered' | 'failed' | 'cancelled'

export interface Job {
  id: string
  prompt: string
  source: Extract<ChangeSource, 'ai' | 'voice'>
  selection: Id[]
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
}

export const ACTIVE_STAGES: JobStage[] = ['thinking', 'repairing', 'placing']
const KEEP_FINISHED = 20

interface QueueState {
  jobs: Job[]
  /** Remote usage since the page loaded. The persistent ledger arrives in phase 9. */
  session: Usage
  submit: (prompt: string, opts?: { source?: Job['source']; selection?: Id[] }) => string
  cancel: (id: string) => void
  retry: (id: string) => void
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

  const addUsage = (usage: Usage) => {
    const s = get().session
    set({ session: { inputTokens: s.inputTokens + usage.inputTokens, outputTokens: s.outputTokens + usage.outputTokens } })
  }

  // One request at a time for now: each edit is validated against the board the previous one left.
  const pump = () => {
    const jobs = get().jobs
    if (jobs.some((j) => ACTIVE_STAGES.includes(j.stage))) return
    const next = jobs.find((j) => j.stage === 'queued')
    if (next) void run(next)
  }

  const run = async (job: Job) => {
    const controller = new AbortController()
    controllers.set(job.id, controller)
    patch(job.id, { stage: 'thinking', startedAt: Date.now() })
    const { settings, secrets } = useSettings.getState()
    try {
      const result = await runEdit({
        prompt: job.prompt,
        provider: createProvider(settings, secrets),
        getBoard: () => useBoard.getState().board,
        getHistory: () => useBoard.getState().history,
        selection: job.selection,
        recent: formatRecent(recentContext(useBoard.getState().history, recentTurns(get().jobs))),
        templates: Object.values(useLibrary.getState().entries).map(latestVersion),
        signal: controller.signal,
        onStage: (stage, { outputTokens, repair }) => patch(job.id, { stage, outputTokens, repair }),
      })
      addUsage(result.usage)
      if (controller.signal.aborted) return finish(job.id, { stage: 'cancelled', usage: result.usage })
      if (result.kind === 'reply') {
        useToast.getState().show({ kind: 'reply', text: result.message, prompt: job.prompt })
        return finish(job.id, { stage: 'answered', reply: result.message, usage: result.usage })
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
      finish(job.id, { stage: 'done', title: result.title, usage: result.usage, txId })
    } catch (e) {
      if (controller.signal.aborted || (e instanceof ProviderError && e.kind === 'aborted')) return finish(job.id, { stage: 'cancelled' })
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
    retry: (id) => {
      const job = get().jobs.find((j) => j.id === id)
      if (job) get().submit(job.prompt, { source: job.source, selection: job.selection })
    },
  }
})

const CHANGED_WHILE_RUNNING = 'The board changed while this request was running, so its changes no longer fit. Try it again.'

/**
 * Undoes `undoIds` (newest first) and then runs `apply`, as one unit: if the history no longer
 * ends with those changes, nothing happens; if applying fails, the undone changes are redone.
 */
function applyEdit(undoIds: string[], apply: () => string | undefined): string | undefined {
  const board = useBoard.getState()
  const newest = board.history.past.slice(board.history.past.length - undoIds.length).map((t) => t.id).reverse()
  if (newest.length !== undoIds.length || newest.some((id, i) => id !== undoIds[i])) {
    throw new ProviderError('bad-request', CHANGED_WHILE_RUNNING)
  }
  undoIds.forEach(() => useBoard.getState().undo())
  try {
    return apply()
  } catch (e) {
    undoIds.forEach(() => useBoard.getState().redo())
    if (e instanceof OpError) throw new ProviderError('bad-request', CHANGED_WHILE_RUNNING)
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
