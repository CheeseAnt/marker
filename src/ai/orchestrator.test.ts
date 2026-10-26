import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { commit } from '../model/apply'
import { resolveBoxes } from '../model/geometry'
import { emptyHistory, record } from '../history/history'
import { toCoreOps } from './llmOps'
import { runEdit, TOOLS } from './orchestrator'
import { buildContext, FULL_BOARD_CHAR_LIMIT } from './prompt'
import type { ChatRequest, ChatResult, LLMProvider } from './providers/types'

const board = parseBoard(`board "Shop" v1
node api "API" rect at(0,0) size(160,80)
node db "Orders DB" ellipse below(api,80)
edge e1 api -> db
`)

/** A provider that answers with scripted tool calls and records what it was asked. */
function scripted(replies: (Partial<ChatResult> & { call?: { name: string; args: unknown } })[]) {
  const requests: ChatRequest[] = []
  const provider: LLMProvider = {
    id: 'fake',
    label: 'Fake',
    capabilities: { vision: true, tools: true, streaming: true, transcription: false },
    async complete(req) {
      requests.push(structuredClone(req))
      const r = replies[requests.length - 1]
      if (!r) throw new Error('no more scripted replies')
      return {
        text: r.text ?? '',
        toolCalls: r.call ? [{ id: `call_${requests.length}`, name: r.call.name, arguments: JSON.stringify(r.call.args) }] : [],
        usage: r.usage ?? { inputTokens: 100, outputTokens: 20 },
        finishReason: 'tool_calls',
      }
    },
    async testConnection() {
      throw new Error('unused')
    },
  }
  return { provider, requests }
}

const edit = (summary: string, ops: unknown[]) => ({ call: { name: 'edit_board', args: { summary, ops } } })

describe('runEdit', () => {
  it('applies a valid edit and lays out unplaced nodes next to their neighbours', async () => {
    const { provider, requests } = scripted([
      edit('Added a cache next to the API', [
        { op: 'add_node', id: 'cache', label: 'Cache', shape: 'rect', style: { fill: '#ffec99' } },
        { op: 'add_edge', from: 'api', to: 'cache', label: 'reads' },
      ]),
    ])
    const result = await runEdit({ prompt: 'add a cache', provider, getBoard: () => board, getHistory: () => emptyHistory(), selection: ['api'] })
    expect(result).toMatchObject({ kind: 'edit', title: 'Added a cache next to the API', repairs: 0, usage: { inputTokens: 100, outputTokens: 20 } })
    if (result.kind !== 'edit') throw new Error()
    const next = commit(board, result.ops).board
    expect(next.elements.find((e) => e.id === 'cache')).toMatchObject({ at: { kind: 'at' }, style: { fill: '#ffec99' } })
    expect(next.elements.find((e) => e.id === 'api_cache')).toMatchObject({ kind: 'edge', label: 'reads' })
    expect(result.changedIds).toEqual(expect.arrayContaining(['cache', 'api_cache']))
    const boxes = resolveBoxes(next)
    expect(boxes.get('cache')!.y).toBeGreaterThan(boxes.get('api')!.y + 80)

    // The model saw the board, the selection and the request, with both tools on offer.
    expect(requests[0].toolChoice).toBe('required')
    expect(requests[0].tools!.map((t) => t.name)).toEqual(['edit_board', 'reply'])
    expect(requests[0].messages[0].content).toContain('node db "Orders DB" ellipse below(api,80)')
    expect(requests[0].messages[0].content).toContain('Selected: api')
    expect(requests[0].messages[0].content).toContain('Request: add a cache')
  })

  it('sends problems back and accepts the corrected call', async () => {
    const { provider, requests } = scripted([
      edit('Linked queue', [{ op: 'add_edge', from: 'api', to: 'queue' }]),
      edit('Added and linked a queue', [
        { op: 'add_node', id: 'queue', label: 'Queue', place: { rel: 'right', of: 'api' } },
        { op: 'add_edge', from: 'api', to: 'queue' },
      ]),
    ])
    const stages: string[] = []
    const result = await runEdit({ prompt: 'add a queue', provider, getBoard: () => board, getHistory: () => emptyHistory(), selection: [], onStage: (s) => stages.push(s) })
    expect(result).toMatchObject({ kind: 'edit', repairs: 1, usage: { inputTokens: 200, outputTokens: 40 } })
    expect(stages).toContain('repairing')
    const followUp = requests[1].messages
    expect(followUp.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_1', name: 'edit_board' }] })
    expect(followUp.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' })
    expect(followUp.at(-1)!.content).toMatch(/edge "api_queue" to "queue" is not a node/)
  })

  it('gives up after the repair limit with the first problem', async () => {
    const bad = edit('Oops', [{ op: 'update', id: 'ghost', label: 'x' }])
    const { provider } = scripted([bad, bad, bad])
    await expect(runEdit({ prompt: 'x', provider, getBoard: () => board, getHistory: () => emptyHistory(), selection: [] })).rejects.toThrow(
      /didn't fit the board after 2 corrections: ops\[0\] \(update "ghost"\): there is no element "ghost"/,
    )
  })

  it('returns replies without touching the board', async () => {
    const { provider } = scripted([{ call: { name: 'reply', args: { message: 'There are two nodes.' } } }])
    await expect(runEdit({ prompt: 'how many nodes?', provider, getBoard: () => board, getHistory: () => emptyHistory(), selection: [] })).resolves.toMatchObject({
      kind: 'reply',
      message: 'There are two nodes.',
    })
  })

  it('undoes the newest change before validating replacement ops', async () => {
    // History: the model previously added a red cache.
    const first = commit(board, [{ op: 'add', element: { kind: 'node', id: 'cache', label: 'Cache', shape: 'rect', style: { fill: '#ffc9c9' }, hints: {} } }])
    const history = record(emptyHistory(), { id: 'tx1', ts: 0, source: 'ai', title: 'Added a cache', prompt: 'add a cache', ops: first.ops, inverse: first.inverse })
    // Re-adding "cache" only fits once the first change is undone.
    const { provider, requests } = scripted([
      {
        call: {
          name: 'edit_board',
          args: {
            summary: 'Added a green cache instead',
            undo_first: 1,
            ops: [{ op: 'add_node', id: 'cache', label: 'Cache', style: { fill: '#b2f2bb' }, place: { rel: 'right', of: 'api' } }],
          },
        },
      },
    ])
    const result = await runEdit({
      prompt: 'undo that and make it green instead',
      provider,
      getBoard: () => first.board,
      getHistory: () => history,
      selection: [],
      recent: 'Recent changes to the board, newest first:\n1. Request "add a cache": Added a cache (cache)',
    })
    expect(result).toMatchObject({ kind: 'edit', undo: { txIds: ['tx1'] }, repairs: 0 })
    if (result.kind !== 'edit') throw new Error()
    expect(String(requests[0].messages[0].content)).toMatch(/^Recent changes/)
    const after = commit(commit(first.board, first.inverse).board, result.ops).board
    expect(after.elements.find((e) => e.id === 'cache')).toMatchObject({ style: { fill: '#b2f2bb' } })
  })

  it('asks for a correction when undo_first reaches past the history', async () => {
    const { provider, requests } = scripted([
      { call: { name: 'edit_board', args: { summary: 'Undid', undo_first: 2, ops: [] } } },
      { call: { name: 'reply', args: { message: 'There is nothing more to undo.' } } },
    ])
    const result = await runEdit({ prompt: 'undo twice', provider, getBoard: () => board, getHistory: () => emptyHistory(), selection: [] })
    expect(result).toMatchObject({ kind: 'reply', repairs: 1 })
    expect(requests[1].messages.at(-1)!.content).toMatch(/undo_first is 2 but only 0 change\(s\) can be undone/)
  })

  it('offers tool schemas the model can follow', () => {
    const edit = TOOLS[0].parameters as { properties: { ops: { items: { oneOf?: unknown[]; anyOf?: unknown[] } } } }
    const variants = edit.properties.ops.items.oneOf ?? edit.properties.ops.items.anyOf
    expect(variants).toHaveLength(13)
    expect(edit.properties).toHaveProperty('undo_first')
  })
})

describe('toCoreOps', () => {
  it('maps friendly ops onto core ops and flags what the model can fix', () => {
    const { ops, issues } = toCoreOps(board, [
      { op: 'update', id: 'db', label: 'Orders', shape: 'rect', place: { x: 10, y: 20 }, style: { stroke: '#e03131' } },
      { op: 'update', id: 'e1', shape: 'rect' },
      { op: 'reorder', id: 'api', to: 'front' },
      { op: 'ungroup', id: 'api' },
      { op: 'set_board_font', font: 'display' },
    ])
    expect(ops[0]).toEqual({ op: 'update', id: 'db', set: { label: 'Orders', shape: 'rect', at: { kind: 'at', x: 10, y: 20 }, style: { stroke: '#e03131' } } })
    expect(ops[1]).toEqual({ op: 'reorder', id: 'api', after: 'e1' })
    expect(ops[2]).toEqual({ op: 'board', set: { defaults: { font: 'display' } } })
    expect(issues).toEqual(['ops[1] (update "e1"): only nodes have a shape', 'ops[1] (update "e1"): nothing to change', 'ops[3] (ungroup "api"): "api" is not a group'])
  })
})

describe('templates', () => {
  const server = parseBoard(`board "Web server" v1
template server "A web server"
param name "Server"
port in box top

node box "{name}" rect at(0,0) size(160,80)
text note "nginx" below(box,10)
`)
  const templates = [{ name: 'server', version: 3, board: server }]

  it('lists the catalog and lets the model add, connect and adjust copies', async () => {
    const { provider, requests } = scripted([
      edit('Added two servers behind the API', [
        { op: 'add_copy', template: 'server', params: { name: 'Web 1' }, place: { rel: 'right', of: 'api' } },
        { op: 'add_copy', template: 'server', params: { name: 'Web 2' } },
        { op: 'add_edge', from: 'api', to: 'server1.in' },
        { op: 'add_edge', from: 'api', to: 'server2.in' },
      ]),
    ])
    const result = await runEdit({ prompt: 'add two web servers', provider, getBoard: () => board, getHistory: () => emptyHistory(), selection: [], templates })
    if (result.kind !== 'edit') throw new Error()
    const next = commit(board, result.ops).board
    expect(Object.keys(next.definitions)).toEqual(['server@3'])
    expect(next.elements.filter((e) => e.kind === 'instance').map((e) => e.id)).toEqual(['server1', 'server2'])
    expect(next.elements.find((e) => e.id === 'api_server1_in')).toMatchObject({ to: { id: 'server1', port: 'in' } })
    const context = String(requests[0].messages[0].content)
    expect(context).toContain('- server: A web server. Fill in: name (default "Server"). Ports: in. Parts: box (node "{name}"), note (text "nginx").')

    // The board text the model sees shows copies but not the embedded definitions.
    const { provider: p2, requests: r2 } = scripted([
      edit('Renamed and recoloured', [{ op: 'update_copy', id: 'server2', params: { name: 'Edge' }, part_style: { box: { fill: '#ffc9c9' } }, part_text: { note: 'envoy' } }]),
      edit('Detached server1', [{ op: 'detach', id: 'server1' }]),
    ])
    const second = await runEdit({ prompt: 'make server2 the edge proxy', provider: p2, getBoard: () => next, getHistory: () => emptyHistory(), selection: [], templates })
    if (second.kind !== 'edit') throw new Error()
    expect(String(r2[0].messages[0].content)).toContain('use server2 server@3')
    expect(String(r2[0].messages[0].content)).not.toContain('define server@3')
    const renamed = commit(next, second.ops).board
    expect(renamed.elements.find((e) => e.id === 'server2')).toMatchObject({ params: { name: 'Edge' }, overrides: { box: { style: { fill: '#ffc9c9' } }, note: { text: 'envoy' } } })

    const third = await runEdit({ prompt: 'detach server1', provider: p2, getBoard: () => renamed, getHistory: () => emptyHistory(), selection: [], templates })
    if (third.kind !== 'edit') throw new Error()
    const detached = commit(renamed, third.ops).board
    expect(detached.elements.find((e) => e.id === 'server1')).toMatchObject({ kind: 'group' })
    expect(detached.elements.find((e) => e.id === 'api_server1_in')).toMatchObject({ to: { id: 'server1_box' } })
  })

  it('names the templates that exist when the model asks for one that does not', () => {
    const { issues } = toCoreOps(board, [{ op: 'add_copy', template: 'database' }], { templates })
    expect(issues).toEqual(['ops[0] (add_copy): there is no template "database" (available: server)'])
  })
})

describe('buildContext', () => {
  it('trims large boards to the selection and its neighbours', () => {
    const lines = ['board "Big" v1']
    for (let i = 0; i < 600; i++) lines.push(`node n${i} "Node number ${i} with a fairly long label" rect at(${i * 10},0)`)
    lines.push('edge link n5 -> n6')
    const big = parseBoard(lines.join('\n'))
    const text = buildContext({ board: big, selection: ['n5'] }, 'rename this')
    expect(text.length).toBeLessThan(FULL_BOARD_CHAR_LIMIT)
    expect(text).toContain('node n5 "Node number 5')
    expect(text).toContain('node n6 "Node number 6')
    expect(text).toContain('edge link n5 -> n6')
    expect(text).not.toContain('node n7 ')
    expect(text).toContain('n7 (node "Node number 7')
  })
})
