import { expect, test } from '@playwright/test'
import { boardState, freshApp, setBoardText } from './helpers'

/**
 * Runs one request against a real Azure deployment. Skipped unless configured:
 *   MARKER_AZURE_ENDPOINT=https://<res>.openai.azure.com MARKER_AZURE_DEPLOYMENT=<name> \
 *   MARKER_AZURE_KEY=<key> npx playwright test e2e/live.spec.ts
 */
const endpoint = process.env.MARKER_AZURE_ENDPOINT
const deployment = process.env.MARKER_AZURE_DEPLOYMENT
const key = process.env.MARKER_AZURE_KEY

test.skip(!endpoint || !deployment || !key, 'set MARKER_AZURE_ENDPOINT, _DEPLOYMENT and _KEY to run')
test.setTimeout(120_000)

test('live: a request adds a connected node', async ({ page }) => {
  await freshApp(page)
  await page.evaluate(
    ({ endpoint, deployment, key }) => {
      localStorage.setItem('marker.settings', JSON.stringify({ providers: { 'azure-foundry': { endpoint, deployment } } }))
      localStorage.setItem('marker.secrets', JSON.stringify({ 'azure-foundry': { apiKey: key } }))
    },
    { endpoint, deployment, key },
  )
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await setBoardText(page, 'board "Shop" v1\n\nnode api "API" rect at(200,150) size(160,70)\nnode db "Orders DB" ellipse below(api,90)\nedge e1 api -> db\n')

  const input = page.getByLabel('Describe a change to the board')
  await input.fill('Add a Redis cache to the right of the API, connected from the API, with a yellow fill')
  await input.press('Enter')
  await expect(page.locator('.toast.done, .toast.error')).toBeVisible({ timeout: 90_000 })
  await page.screenshot({ path: 'e2e/screenshots/live.png' })
  await expect(page.locator('.toast.error')).toBeHidden()

  const { board, history } = await boardState(page)
  const cache = board.elements.find((e) => e.kind === 'node' && /cache|redis/i.test(e.label ?? ''))
  expect(cache).toBeTruthy()
  expect(board.elements.some((e) => e.kind === 'edge' && JSON.stringify(e).includes(cache!.id))).toBe(true)
  console.log('title:', history.past.at(-1)?.title)
  console.log(await page.evaluate(() => (window as unknown as { __marker: { useJobs: { getState(): { session: unknown } } } }).__marker.useJobs?.getState().session))
})
