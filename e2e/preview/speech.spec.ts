import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const SPEECH = fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url))
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH}`] },
  permissions: ['microphone'],
})

test('the production build transcribes speech on the device', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('boardbot.settings', JSON.stringify({ voice: { mode: 'on-device', onDeviceModel: 'moonshine-tiny' } })))
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)

  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.down('Space')
  await page.waitForTimeout(3200)
  await page.keyboard.up('Space')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  // The first use downloads the model while recording; transcription follows.
  await expect(page.getByLabel('Describe a change to the board')).toHaveValue(/database/i, { timeout: 120_000 })
})
