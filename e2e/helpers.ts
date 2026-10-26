import type { Page, Route } from '@playwright/test'

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'api-key,content-type',
  'access-control-allow-methods': 'POST',
}

export function sse(events: unknown[]) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
}

export function toolCallStream(name: string, args: unknown, usage = { prompt_tokens: 900, completion_tokens: 120 }) {
  const json = JSON.stringify(args)
  const mid = Math.floor(json.length / 2)
  return sse([
    { model: 'gpt-5.6-luna', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: json.slice(0, mid) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage },
  ])
}

/** Routes https://res.openai.azure.com through `respond`, answering CORS preflights. */
export async function fakeAzure(page: Page, respond: (route: Route, body: Record<string, unknown>, n: number) => Promise<void>) {
  const bodies: Record<string, unknown>[] = []
  await page.route('https://res.openai.azure.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    return respond(route, body, bodies.length)
  })
  return bodies
}

export async function freshApp(page: Page, opts: { configured?: boolean } = {}) {
  await page.goto('/')
  await page.evaluate(
    ({ configured }) => {
      localStorage.clear()
      indexedDB.deleteDatabase('keyval-store')
      if (configured) {
        localStorage.setItem('boardbot.settings', JSON.stringify({ providers: { 'azure-foundry': { endpoint: 'https://res.openai.azure.com', deployment: 'gpt-5.6-luna' } } }))
        localStorage.setItem('boardbot.secrets', JSON.stringify({ 'azure-foundry': { apiKey: 'k' } }))
      }
    },
    { configured: opts.configured ?? false },
  )
  await page.reload()
  await page.locator('.excalidraw').waitFor()
}

export async function setBoardText(page: Page, text: string) {
  await page.getByRole('button', { name: 'Board text' }).click()
  await page.getByRole('textbox', { name: 'Board text' }).fill(text)
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.getByRole('button', { name: 'Board text' }).click()
}

export type BoardState = {
  board: { elements: { id: string; kind: string; label?: string; at?: unknown; style?: Record<string, unknown> }[] }
  history: { past: { title: string; prompt?: string; source: string }[] }
}

export const boardState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __boardbot: { useBoard: { getState(): unknown } } }).__boardbot.useBoard.getState()) as Promise<BoardState>
