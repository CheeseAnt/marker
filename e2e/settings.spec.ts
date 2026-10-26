import { expect, test, type Page, type Route } from '@playwright/test'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'api-key,content-type',
  'access-control-allow-methods': 'POST',
}

function sse(events: unknown[]) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function fakeAzure(page: Page, respond: (route: Route) => Promise<void>) {
  const seen: { url: string; key: string | null }[] = []
  await page.route('https://res.openai.azure.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    seen.push({ url: route.request().url(), key: route.request().headers()['api-key'] ?? null })
    return respond(route)
  })
  return seen
}

test('configure Azure, test the connection, save, and focus the prompt with /', async ({ page }) => {
  const seen = await fakeAzure(page, (route) =>
    route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream' },
      body: sse([
        { model: 'gpt-5.6-luna', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'confirm', arguments: '{"ok":true}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 6 } },
      ]),
    }),
  )
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(page.getByRole('button', { name: /Azure AI Foundry not set up/ })).toBeVisible()
  // Draw opens settings while no model is configured.
  await page.getByRole('button', { name: 'Draw' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Endpoint URL').fill(
    'https://res.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=2025-01-01-preview',
  )
  await dialog.getByLabel('Deployment name').click()
  await expect(dialog.getByLabel('Deployment name')).toHaveValue('gpt-5.6-luna')
  await dialog.getByLabel('API key').fill('test-key-123')
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toHaveText(/Connected to gpt-5\.6-luna in .* Tool calling works\./)
  expect(seen[0]).toEqual({
    url: 'https://res.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=2025-01-01-preview',
    key: 'test-key-123',
  })
  await page.screenshot({ path: 'e2e/screenshots/settings.png' })

  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Azure AI Foundry: gpt-5.6-luna' })).toBeVisible()
  const stored = await page.evaluate(() => ({ settings: localStorage.getItem('boardbot.settings'), secrets: localStorage.getItem('boardbot.secrets') }))
  expect(stored.settings).not.toContain('test-key-123')
  expect(stored.secrets).toContain('test-key-123')

  // "/" jumps to the prompt; Escape leaves it.
  await page.locator('canvas.interactive').click({ position: { x: 600, y: 400 } })
  await page.keyboard.press('/')
  await expect(page.getByLabel('Describe a change to the board')).toBeFocused()
  await page.keyboard.type('add a cache')
  await expect(page.getByLabel('Describe a change to the board')).toHaveValue('add a cache')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Describe a change to the board')).not.toBeFocused()
})

test('connection errors are explained in the dialog', async ({ page }) => {
  await fakeAzure(page, (route) =>
    route.fulfill({ status: 401, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'Access denied due to invalid subscription key.' } }) }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByLabel('Endpoint URL').fill('https://res.openai.azure.com')
  await dialog.getByLabel('Deployment name').fill('gpt-5.6-luna')
  await dialog.getByLabel('API key').fill('wrong')
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toHaveText(/Azure rejected the API key \(401\)\. .*invalid subscription key/)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // Cancel discards edits.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog.getByLabel('Endpoint URL')).toHaveValue('')
})
