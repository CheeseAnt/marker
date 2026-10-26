import { useEffect, useState } from 'react'
import { isPending, useJobs, type JobStage } from '../jobs/queue'

const STAGE_LABELS: Partial<Record<JobStage, string>> = {
  queued: 'Waiting',
  thinking: 'Working out',
  repairing: 'Correcting',
  placing: 'Placing',
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function snippet(text: string, max = 36): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The request being worked on, with elapsed time and tokens, and how many are waiting. */
export function JobStatus() {
  const jobs = useJobs((s) => s.jobs)
  const cancel = useJobs((s) => s.cancel)
  const pending = jobs.filter(isPending)
  const active = pending.find((j) => j.stage !== 'queued')
  const [, tick] = useState(0)

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [active])

  if (!active) return null
  const seconds = Math.floor((Date.now() - (active.startedAt ?? Date.now())) / 1000)
  const waiting = pending.length - 1
  const stage = STAGE_LABELS[active.stage] ?? ''
  return (
    <span className="job-status" role="status">
      <span className="job-stage">
        {stage}
        {active.stage === 'repairing' ? ` (${active.repair} of 2)` : ''}
      </span>
      <span className="job-prompt">“{snippet(active.prompt)}”</span>
      <span className="job-meta">
        {seconds} s{active.outputTokens ? `, ${formatTokens(active.outputTokens)} tokens` : ''}
        {waiting > 0 ? `, ${waiting} more waiting` : ''}
      </span>
      <button type="button" className="status-link" onClick={() => cancel(active.id)}>
        Cancel
      </button>
    </span>
  )
}

export function SessionUsage() {
  const session = useJobs((s) => s.session)
  const total = session.inputTokens + session.outputTokens
  if (total === 0) return null
  return (
    <span title={`${session.inputTokens.toLocaleString()} in, ${session.outputTokens.toLocaleString()} out`}>
      {formatTokens(total)} tokens this session
    </span>
  )
}
