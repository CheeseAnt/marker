import { useEffect, useRef, useState } from 'react'
import { isPending, useJobs, type Job, type JobStage } from '../jobs/queue'
import { since, totals } from '../usage/aggregate'
import { formatTokens, formatUsd } from '../usage/format'
import { useUsage } from '../usage/ledger'

const STAGE_LABELS: Partial<Record<JobStage, string>> = {
  queued: 'Waiting',
  thinking: 'Working out',
  repairing: 'Correcting',
  placing: 'Placing',
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function snippet(text: string, max = 36): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function elapsed(job: Job): string {
  return `${Math.floor(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000)} s`
}

/** What a request is doing now, in words. */
function stateText(job: Job): string {
  switch (job.stage) {
    case 'queued':
      return job.redone ? 'Waiting to be redone on the changed board' : 'Waiting'
    case 'thinking':
    case 'repairing':
    case 'placing': {
      const what = job.stage === 'repairing' ? `Correcting (${job.repair} of 2)` : (STAGE_LABELS[job.stage] ?? '')
      const redo = job.redone ? ', redoing on the changed board' : ''
      return `${what}${redo}, ${elapsed(job)}${job.outputTokens ? `, ${formatTokens(job.outputTokens)} tokens` : ''}`
    }
    case 'done':
      return job.title ?? 'Done'
    case 'answered':
      return job.reply ?? ''
    case 'failed':
      return job.error ?? 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

function JobRow({ job }: { job: Job }) {
  const { cancel, retry } = useJobs.getState()
  const pending = isPending(job)
  const working = pending && job.stage !== 'queued'
  const tokens = job.usage ? job.usage.inputTokens + job.usage.outputTokens : 0
  const spent = totals(useUsage((s) => s.records).filter((r) => r.jobId === job.id))
  return (
    <li className={`queue-row ${job.stage}`}>
      <div className="queue-main">
        <p className="queue-prompt">{job.prompt}</p>
        <p className="queue-state">{stateText(job)}</p>
        {working && <span className="queue-progress" aria-hidden="true" />}
        {!pending && (
          <p className="queue-meta">
            {job.source === 'voice' ? 'Spoken, ' : ''}
            {time.format(job.finishedAt ?? job.createdAt)}, {elapsed(job)}
            {tokens ? `, ${formatTokens(tokens)} tokens` : ''}
            {spent.calls > spent.unpriced ? `, ${formatUsd(spent.cost)}` : ''}
          </p>
        )}
      </div>
      <div className="queue-actions">
        {pending && (
          <button type="button" onClick={() => cancel(job.id)}>
            Cancel
          </button>
        )}
        {(job.stage === 'failed' || job.stage === 'cancelled') && (
          <button type="button" onClick={() => retry(job.id)}>
            Try again
          </button>
        )}
      </div>
    </li>
  )
}

/** Every request this session: being worked on, waiting, and recently finished. */
function QueuePanel({ onClose }: { onClose: () => void }) {
  const jobs = useJobs((s) => s.jobs)
  const clearFinished = useJobs((s) => s.clearFinished)
  const ref = useRef<HTMLDivElement>(null)
  const working = jobs.filter((j) => isPending(j) && j.stage !== 'queued')
  const waiting = jobs.filter((j) => j.stage === 'queued')
  const finished = jobs.filter((j) => !isPending(j)).reverse()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.job-status')) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [onClose])

  return (
    <div ref={ref} className="queue-panel" role="dialog" aria-label="Requests">
      <div className="queue-header">
        <h2>Requests</h2>
        <span className="spacer" />
        {finished.length > 0 && (
          <button type="button" className="status-link" onClick={clearFinished}>
            Clear finished
          </button>
        )}
      </div>
      {jobs.length === 0 ? (
        <p className="drawer-empty">Requests you type or speak are listed here while they're worked out, and for a while after.</p>
      ) : (
        <ol className="queue-list">
          {[...working, ...waiting, ...finished].map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ol>
      )}
    </div>
  )
}

/** The request being worked on, with time and tokens; opens the full list of requests. */
export function JobStatus() {
  const jobs = useJobs((s) => s.jobs)
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const pending = jobs.filter(isPending)
  const working = pending.filter((j) => j.stage !== 'queued')

  useEffect(() => {
    if (!working.length) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [working.length])

  if (jobs.length === 0) return null
  const lead = working[0]
  const others = pending.length - (lead ? 1 : 0)
  return (
    <span className="job-status-wrap">
      <button type="button" className="job-status" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {lead ? (
          <>
            <span className="job-stage">{lead.stage === 'repairing' ? 'Correcting' : (STAGE_LABELS[lead.stage] ?? '')}</span>
            <span className="job-prompt">“{snippet(lead.prompt)}”</span>
            <span className="job-meta">
              {elapsed(lead)}
              {lead.outputTokens ? `, ${formatTokens(lead.outputTokens)} tokens` : ''}
              {others > 0 ? `, ${others} more` : ''}
            </span>
          </>
        ) : pending.length ? (
          <span className="job-meta">{pending.length} waiting</span>
        ) : (
          <span className="job-meta">Requests</span>
        )}
      </button>
      {open && <QueuePanel onClose={() => setOpen(false)} />}
    </span>
  )
}

/** This session's usage and cost; opens the usage panel. */
export function SessionUsage({ onOpen }: { onOpen: () => void }) {
  const records = useUsage((s) => s.records)
  const start = useUsage((s) => s.sessionStart)
  const t = totals(since(records, start))
  const tokens = t.inputTokens + t.outputTokens
  if (t.calls === 0) return null
  const cost = t.unpriced && !t.cost ? '' : `, ${t.unpriced ? 'at least ' : ''}${formatUsd(t.cost)}`
  return (
    <button type="button" className="status-link" onClick={onOpen} title={`${t.inputTokens.toLocaleString()} in, ${t.outputTokens.toLocaleString()} out`}>
      This session: {formatTokens(tokens)} tokens{cost}
    </button>
  )
}
