import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { CORS, fakeAzure, freshApp, setBoardText, toolCallStream } from './helpers'

test('prices set in Settings cost each request, shown in the strip, the usage tab and CSV', async ({ page }) => {
  await fakeAzure(page, (route) =>
    route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream' },
      body: toolCallStream('edit_board', { summary: 'Added a cache', ops: [{ op: 'add_node', id: 'cache', label: 'Cache' }] }, { prompt_tokens: 120_000, completion_tokens: 8_000 }),
    }),
  )
  await freshApp(page, { configured: true })
  await setBoardText(page, 'board "U" v1\n\nnode api "API" rect at(100,100) size(160,70)\n')

  // A few earlier days, so the chart has something to show.
  await page.evaluate(() => {
    const { useUsage } = (window as unknown as { __marker: { useUsage: { getState(): { add(r: unknown): void } } } }).__marker
    const day = 24 * 3600 * 1000
    ;[[9, 0.21], [6, 0.08], [5, 0.4], [2, 0.12], [1, 0.33]].forEach(([ago, cost]) =>
      useUsage.getState().add({ ts: Date.now() - ago * day, kind: 'chat', provider: 'azure-foundry', deployment: 'gpt-5.6-luna', inputTokens: 90_000, outputTokens: 6_000, cost }),
    )
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByText('No default price: enter yours to see costs.')).toBeVisible()
  await dialog.getByLabel('gpt-5.6-luna: Input, $ per 1M tokens').fill('1.5')
  await dialog.getByLabel('gpt-5.6-luna: Output, $ per 1M tokens').fill('12')
  await dialog.getByLabel('Warn me when this month passes ($)').fill('5')
  await dialog.getByRole('button', { name: 'Save' }).click()

  const input = page.getByLabel('Describe a change to the board')
  await input.fill('add a cache')
  await input.press('Enter')
  await expect(page.locator('.toast.done')).toContainText('Added a cache')
  // 120k in at $1.50/M + 8k out at $12/M = $0.18 + $0.096
  await expect(page.getByRole('button', { name: /This session: 128k tokens, \$0\.28/ })).toBeVisible()

  await page.getByRole('button', { name: /This session/ }).click()
  const tiles = page.locator('.usage-tile-value')
  await expect(tiles.nth(0)).toHaveText('$0.28')
  await expect(tiles.nth(2)).toHaveText(/\$/)
  await expect(page.locator('.usage-bar')).not.toHaveCount(0)
  await expect(page.locator('.usage-budget')).toContainText('of the $5.00 you wanted a warning at')
  await page.locator('.usage-bar').last().hover()
  await expect(page.locator('.usage-tooltip')).toContainText('$0.28')
  await page.screenshot({ path: 'e2e/screenshots/usage-panel.png' })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const csv = readFileSync(await (await download).path(), 'utf8')
  expect(csv.split('\n')[0]).toMatch(/^time,kind,provider,deployment/)
  expect(csv).toMatch(/chat,azure-foundry,gpt-5\.6-luna,gpt-5\.6-luna,120000,0,8000,,0\.276000,/)
})
