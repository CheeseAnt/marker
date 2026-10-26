import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('export settings without the key, import them into a fresh app, and only the key is missing', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem(
      'boardbot.settings',
      JSON.stringify({
        providers: { 'azure-foundry': { endpoint: 'https://res.openai.azure.com', deployment: 'gpt-5.6-luna', transcriptionDeployment: 'gpt-4o-transcribe' } },
        voice: { mode: 'remote', autoSend: true },
        pricing: { 'gpt-5.6-luna': { input: 1.5, output: 12 } },
        budget: { warnAt: 5, limit: 20 },
      }),
    )
    localStorage.setItem('boardbot.secrets', JSON.stringify({ 'azure-foundry': { apiKey: 'my-real-key-abc' } }))
  })
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await expect(page.getByRole('button', { name: 'Azure AI Foundry: gpt-5.6-luna' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export settings' }).click()
  const saved = await (await download).path()
  const text = readFileSync(saved, 'utf8')
  expect(JSON.parse(text)).toMatchObject({ schema: 'boardbot-settings', version: 1, settings: { voice: { mode: 'remote' }, budget: { limit: 20 } } })
  expect(text).not.toContain('my-real-key-abc')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // A fresh start, as on another computer.
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await expect(page.getByRole('button', { name: 'Azure AI Foundry not set up' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Import settings…' }).click()
  await (await chooser).setFiles(saved)
  const review = dialog.locator('.import-review')
  await expect(review).toContainText('Endpoint URL (empty) → https://res.openai.azure.com')
  await expect(review).toContainText('Voice on-device → remote')
  await expect(review).toContainText('Prices for gpt-5.6-luna (defaults) → input 1.5, output 12')
  await page.screenshot({ path: 'e2e/screenshots/settings-import.png' })
  await review.getByRole('button', { name: 'Use these settings' }).click()
  await expect(dialog.locator('.settings-transfer-result')).toContainText('press Save to keep it')
  await expect(dialog.getByLabel('Deployment name')).toHaveValue('gpt-5.6-luna')
  await expect(dialog.getByLabel('API key')).toHaveValue('')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: 'Azure AI Foundry needs an API key' })).toBeVisible()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('boardbot.settings')!))
  expect(stored).toMatchObject({ jobConcurrency: 2, budget: { warnAt: 5, limit: 20 }, voice: { autoSend: true } })

  // A file that isn't settings is explained, not imported.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const chooser2 = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Import settings…' }).click()
  await (await chooser2).setFiles({ name: 'board.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') })
  await expect(dialog.getByRole('alert')).toHaveText("This file isn't a BoardBot settings file.")
})
