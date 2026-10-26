import { parseBoard } from '../src/dsl/parse'
import { resolveBoxes } from '../src/model/geometry'
import type { Board } from '../src/model/types'
import { boardFont, connected, count, edgeLabel, has, hasNone, instances, placed, removed, reversed, style, unchanged, type Check } from './checks'

export interface EvalCase {
  id: string
  prompt: string
  board: Board
  selection?: string[]
  /** What the model should do: edit the board (default) or only answer. */
  expect?: 'edit' | 'reply'
  checks: Check[]
  /** Templates offered to the model, by board text. */
  templates?: string[]
}

const SHOP = parseBoard(`board "Shop" v1

node web "Web app" rect at(0,0) size(160,70)
node api "API" rect at(0,180) size(160,70)
node db "Orders DB" ellipse at(0,360) size(160,70)
edge e1 web -> api
edge e2 api -> db "queries"
`)

const EMPTY = parseBoard('board "Empty" v1\n')

const SERVER = `board "Server" v1
template server "A web server"
param name "Server"
port in box top

node box "{name}" rect at(0,0) size(160,80)
`

const WITH_COPIES = parseBoard(`board "Racks" v1

node lb "Load balancer" rect at(0,0) size(200,60)
use s1 server@1 at(0,150) with(name="Web 1")
edge e1 lb -> s1.in

define server@1 {
${SERVER.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}
}
`)

const boxes = (b: Board) => resolveBoxes(b)

/** Requests a whiteboard user is likely to make, from simple to compound. */
export const CASES: EvalCase[] = [
  { id: 'add-node', prompt: 'add a cache', board: SHOP, checks: [has(/cache/i), count('node', 4)] },
  { id: 'add-and-connect', prompt: 'add a Redis cache and connect the API to it', board: SHOP, checks: [has(/redis|cache/i), connected('api', /redis|cache/i)] },
  { id: 'place-relative', prompt: 'put a "Payments" service to the right of the API', board: SHOP, checks: [has(/payments/i), placed(/payments/i, 'right', 'api', boxes)] },
  { id: 'place-below', prompt: 'add a backup database below the orders DB', board: SHOP, checks: [has(/backup/i), placed(/backup/i, 'below', 'db', boxes)] },
  { id: 'colour', prompt: 'make the database green', board: SHOP, checks: [style('db', 'fill', /^#(b2f2bb|.*[a-f0-9]{6})$/i), unchanged('api')] },
  { id: 'colour-selection', prompt: 'make this red', board: SHOP, selection: ['web'], checks: [style('web', 'fill', /^#(ffc9c9|ff|e0|f[0-9a-f])/i), unchanged('db')] },
  { id: 'rename-selection', prompt: 'rename this to Storefront', board: SHOP, selection: ['web'], checks: [has(/storefront/i), count('node', 3)] },
  { id: 'delete', prompt: 'remove the orders database', board: SHOP, checks: [removed('db'), removed('e2'), unchanged('web')] },
  { id: 'delete-edge', prompt: 'disconnect the web app from the API', board: SHOP, checks: [removed('e1'), count('node', 3)] },
  { id: 'edge-label', prompt: 'label the arrow from the web app to the API "HTTPS"', board: SHOP, checks: [edgeLabel('e1', /https/i)] },
  { id: 'dashed', prompt: 'make the arrow between the API and the DB dashed', board: SHOP, checks: [style('e2', 'line', /dashed/)] },
  { id: 'reverse-arrow', prompt: 'reverse the arrow between the web app and the API', board: SHOP, checks: [reversed('e1', 'api')] },
  { id: 'group', prompt: 'group the API and the database together as "Backend"', board: SHOP, checks: [count('group', 1), (after) => { const g = after.elements.find((e) => e.kind === 'group'); return g?.kind === 'group' && g.members.includes('api') && g.members.includes('db') ? undefined : 'group misses api or db' }] },
  { id: 'note', prompt: 'add a note saying "TODO: add auth" next to the API', board: SHOP, checks: [(after) => (after.elements.some((e) => (e.kind === 'text' || (e.kind === 'node' && e.shape === 'sticky')) && /auth/i.test(e.kind === 'text' ? e.text : e.label)) ? undefined : 'no auth note')] },
  { id: 'sticky', prompt: 'add a sticky note reminding me to load test', board: SHOP, checks: [(after) => (after.elements.some((e) => e.kind === 'node' && e.shape === 'sticky' && /load/i.test(e.label)) ? undefined : 'no sticky about load testing')] },
  { id: 'decision', prompt: 'add a decision diamond "In stock?" between the API and the DB', board: SHOP, checks: [(after) => (after.elements.some((e) => e.kind === 'node' && e.shape === 'diamond' && /stock/i.test(e.label)) ? undefined : 'no diamond'), connected('api', /stock/i)] },
  { id: 'flowchart', prompt: 'draw a login flow: start, enter credentials, check password, success, and failure', board: EMPTY, checks: [count('node', (n) => n + 5), has(/credential/i), has(/success/i), has(/fail/i), connected(/check|password/i, /success/i)] },
  { id: 'chain', prompt: 'add three steps in a row: build, test, deploy, connected in order', board: EMPTY, checks: [has(/build/i), has(/test/i), has(/deploy/i), connected(/build/i, /test/i), connected(/test/i, /deploy/i)] },
  { id: 'font-element', prompt: 'make the API label use the monospace font', board: SHOP, checks: [style('api', 'font', /mono|code/)] },
  { id: 'font-board', prompt: 'use the rounded font for the whole board', board: SHOP, checks: [boardFont('normal')] },
  { id: 'bigger', prompt: 'make the database bigger', board: SHOP, checks: [(after) => { const d = after.elements.find((e) => e.id === 'db'); return d?.kind === 'node' && d.size && d.size.w > 160 ? undefined : 'db not bigger' }] },
  { id: 'front', prompt: 'bring the web app to the front', board: SHOP, checks: [(after) => (after.elements.filter((e) => e.kind !== 'group').at(-1)?.id === 'web' ? undefined : 'web not on top')] },
  { id: 'drawing', prompt: 'draw a small cloud icon above the web app', board: SHOP, checks: [(after) => (after.elements.some((e) => e.kind === 'draw' || (e.kind === 'node' && /cloud/i.test(e.label))) ? undefined : 'no cloud')] },
  { id: 'question', prompt: 'how many services are on this board?', board: SHOP, expect: 'reply', checks: [unchanged('web'), unchanged('api'), unchanged('db')] },
  { id: 'unclear', prompt: 'do the thing', board: SHOP, expect: 'reply', checks: [count('node', 3)] },
  { id: 'template-add', prompt: 'add two more web servers connected from the load balancer', board: WITH_COPIES, templates: [SERVER], checks: [instances('server', 3), connected('lb', /^s|server/)] },
  { id: 'template-rename', prompt: 'call the server "Primary"', board: WITH_COPIES, templates: [SERVER], checks: [(after) => { const s = after.elements.find((e) => e.id === 's1'); return s?.kind === 'instance' && (/primary/i.test(s.params.name ?? '') || /primary/i.test(s.overrides.box?.text ?? '')) ? undefined : 's1 not renamed' }] },
  { id: 'template-detach', prompt: 'detach the server so I can edit its parts', board: WITH_COPIES, templates: [SERVER], checks: [instances('server', 0), has(/web 1/i)] },
  { id: 'multi-style', prompt: 'make every box blue', board: SHOP, checks: [style('web', 'fill', /^#/), style('api', 'fill', /^#/)] },
  { id: 'keep-others', prompt: 'add a load balancer above the web app', board: SHOP, checks: [has(/load balancer/i), unchanged('api'), unchanged('db'), unchanged('e2')] },
  { id: 'remove-all-db', prompt: 'delete everything except the web app', board: SHOP, checks: [hasNone(/api|orders/i), has(/web app/i)] },
]
