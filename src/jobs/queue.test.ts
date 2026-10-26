import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderError, type ChatRequest, type ChatResult, type LLMProvider } from '../ai/providers/types'
import { parseBoard } from '../dsl/parse'
import { useBoard } from '../state/board'

/** Each model call waits until the test answers it, so the test controls the order. */
const calls: { req: ChatRequest; answer: (r: Partial<ChatResult>) => void }[] = []
const provider: LLMProvider = {
  id: 'fake',
  label: 'Fake',
  capabilities: { vision: true, tools: true, streaming: true, transcription: false },
  complete: (req, { signal }) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new ProviderError('aborted', 'Request cancelled.')))
      calls.push({ req, answer: (r) => resolve({ text: '', toolCalls: [], finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 2 }, ...r }) })
    }),
  testConnection: async () => {
    throw new Error('unused')
  },
}
vi.mock('../ai/providers', () => ({ createProvider: () => provider, isProviderReady: () => true }))

/** Layout can be held open, to let another change land between checking and applying. */
let layoutGate: Promise<void> | null = null
vi.mock('../compile/layout', async (original) => {
  const real = (await original()) as typeof import('../compile/layout')
  return {
    ...real,
    placeUnplaced: async (...args: Parameters<typeof real.placeUnplaced>) => {
      await layoutGate
      return real.placeUnplaced(...args)
    },
  }
})

const { useJobs } = await import('./queue')

const edit = (summary: string, ops: unknown[]) => ({ toolCalls: [{ id: 'c', name: 'edit_board', arguments: JSON.stringify({ summary, ops }) }] })
const tick = () => new Promise((r) => setTimeout(r, 0))
const stages = () => useJobs.getState().jobs.map((j) => j.stage)
const promptOf = (i: number) => {
  const content = calls[i].req.messages[0].content
  return String(typeof content === 'string' ? content : '').split('Request: ')[1]
}

beforeEach(() => {
  calls.length = 0
  useJobs.setState({ jobs: [], session: { inputTokens: 0, outputTokens: 0 } })
  useBoard.getState().load(parseBoard('board "q" v1\nnode x "X" rect at(0,0)\nnode y "Y" rect at(300,0)\n'))
})

describe('job queue', () => {
  it('works on two requests at once and starts the third when one finishes', async () => {
    const { submit } = useJobs.getState()
    submit('first')
    submit('second')
    submit('third')
    await tick()
    expect(stages()).toEqual(['thinking', 'thinking', 'queued'])
    expect(calls.map((_, i) => promptOf(i))).toEqual(['first', 'second'])

    calls[1].answer(edit('Renamed y', [{ op: 'update', id: 'y', label: 'Why' }]))
    await vi.waitFor(() => expect(stages()).toEqual(['thinking', 'done', 'thinking']))
    calls[0].answer(edit('Renamed x', [{ op: 'update', id: 'x', label: 'Ex' }]))
    calls[2].answer(edit('Coloured x', [{ op: 'update', id: 'x', style: { fill: '#ffec99' } }]))
    await vi.waitFor(() => expect(stages()).toEqual(['done', 'done', 'done']))
    expect(useBoard.getState().history.past.map((t) => t.title)).toEqual(['Renamed y', 'Renamed x', 'Coloured x'])
    expect(useJobs.getState().session).toEqual({ inputTokens: 30, outputTokens: 6 })
  })

  it('tells the model when an earlier change removed what it was editing', async () => {
    const { submit } = useJobs.getState()
    submit('remove x')
    submit('rename x')
    await tick()
    calls[0].answer(edit('Removed x', [{ op: 'remove', id: 'x' }]))
    await vi.waitFor(() => expect(stages()[0]).toBe('done'))
    // The rename was worked out against the old board; it is checked against the new one.
    calls[1].answer(edit('Renamed x', [{ op: 'update', id: 'x', label: 'Ex' }]))
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(stages()[1]).toBe('repairing')
    expect(calls[2].req.messages.at(-1)!.content).toMatch(/there is no element "x"/)
    calls[2].answer({ toolCalls: [{ id: 'r', name: 'reply', arguments: JSON.stringify({ message: 'x was removed, so there is nothing to rename.' }) }] })
    await vi.waitFor(() => expect(stages()).toEqual(['done', 'answered']))
    expect(useJobs.getState().jobs[1].usage).toEqual({ inputTokens: 20, outputTokens: 4 })
  })

  it('redoes a request once when another change lands between checking and applying it', async () => {
    let release: () => void = () => {}
    layoutGate = new Promise((r) => (release = r))
    const { submit } = useJobs.getState()
    submit('add z next to x')
    await tick()
    calls[0].answer(edit('Added z', [{ op: 'add_node', id: 'z', label: 'Z', place: { rel: 'right', of: 'x' } }]))
    await tick()
    // While layout runs, someone deletes x on the canvas.
    useBoard.getState().apply([{ op: 'remove', id: 'x' }], 'manual')
    release()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(useJobs.getState().jobs[0]).toMatchObject({ stage: 'thinking', redone: true })
    layoutGate = null
    calls[1].answer(edit('Added z', [{ op: 'add_node', id: 'z', label: 'Z', place: { rel: 'right', of: 'y' } }]))
    await vi.waitFor(() => expect(stages()).toEqual(['done']))
    expect(useBoard.getState().board.elements.some((e) => e.id === 'z')).toBe(true)
  })

  it('cancels waiting and running requests', async () => {
    const { submit, cancel } = useJobs.getState()
    const a = submit('a')
    submit('b')
    const c = submit('c')
    await tick()
    cancel(c)
    expect(stages()).toEqual(['thinking', 'thinking', 'cancelled'])
    cancel(a)
    await vi.waitFor(() => expect(stages()[0]).toBe('cancelled'))
    useJobs.getState().clearFinished()
    expect(stages()).toEqual(['thinking'])
  })
})
