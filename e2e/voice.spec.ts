import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { CORS, fakeAzure, setBoardText, toolCallStream } from './helpers'

// Chrome's fake microphone plays this file (a spoken request, looped) instead of real input.
const SPEECH = fileURLToPath(new URL('./fixtures/speech.wav', import.meta.url))
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH}`] },
  permissions: ['microphone'],
})

const BOARD = 'board "Voice" v1\n\nnode api "API" rect at(120,120) size(160,70)\n'

async function openWith(page: Page, settings: Record<string, unknown>) {
  await page.goto('/')
  await page.evaluate((settings) => {
    localStorage.clear()
    indexedDB.deleteDatabase('keyval-store')
    localStorage.setItem('marker.settings', JSON.stringify(settings))
    localStorage.setItem('marker.secrets', JSON.stringify({ 'azure-foundry': { apiKey: 'k' } }))
  }, settings)
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await setBoardText(page, BOARD)
}

const remote = (autoSend: boolean) => ({
  providers: { 'azure-foundry': { endpoint: 'https://res.openai.azure.com', deployment: 'gpt-5.6-luna', transcriptionDeployment: 'gpt-4o-transcribe' } },
  voice: { mode: 'remote', autoSend },
})

test('hold the shortcut to speak a request, which is sent straight away', async ({ page }) => {
  await fakeAzure(page, (route) =>
    route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream' },
      body: toolCallStream('edit_board', { summary: 'Added a cache', ops: [{ op: 'add_node', id: 'cache', label: 'Cache', place: { rel: 'right', of: 'api' } }] }),
    }),
  )
  // Registered last so it wins over the chat route for audio uploads.
  const audio: number[] = []
  await page.route('https://res.openai.azure.com/**/audio/transcriptions**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    audio.push(route.request().postDataBuffer()?.length ?? 0)
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Add a cache next to the API.', usage: { input_tokens: 60, output_tokens: 8 } }) })
  })
  await openWith(page, remote(true))
  await expect(page.getByRole('button', { name: 'Voice: gpt-4o-transcribe' })).toBeVisible()

  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.down('Space')
  await expect(page.locator('.voice-status.recording')).toBeVisible()
  await expect(page.getByLabel('Describe a change to the board')).toHaveAttribute('placeholder', 'Listening… release to finish')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'e2e/screenshots/voice-recording.png' })
  await page.keyboard.up('Space')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')

  await expect(page.locator('.toast.done')).toContainText('Added a cache')
  // About 1.5 s of 16 kHz 16-bit audio, plus the form around it.
  expect(audio[0]).toBeGreaterThan(16000 * 2)
  const history = await page.evaluate(() => (window as unknown as { __marker: { useBoard: { getState(): { history: { past: { source: string; prompt?: string }[] } } } } }).__marker.useBoard.getState().history.past.at(-1))
  expect(history).toMatchObject({ source: 'voice', prompt: 'Add a cache next to the API.' })
})

test('tap the microphone to start and again to stop; the text waits in the prompt bar', async ({ page }) => {
  await page.route('https://res.openai.azure.com/**/audio/transcriptions**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'make it blue' }) }),
  )
  await openWith(page, remote(false))
  const input = page.getByLabel('Describe a change to the board')
  await input.fill('please')
  const mic = page.getByRole('button', { name: 'Speak a change' })
  await mic.click()
  await expect(page.locator('.voice-status.recording')).toBeVisible()
  await page.waitForTimeout(700)
  await expect(page.locator('.voice-status.recording')).toBeVisible()
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect(input).toHaveValue('please make it blue')
  await expect(input).toBeFocused()
})

test('on-device speech model transcribes real speech', async ({ page }) => {
  test.skip(!process.env.MARKER_SPEECH_E2E, 'downloads a speech model; set MARKER_SPEECH_E2E=1 to run')
  test.setTimeout(240_000)
  await openWith(page, { voice: { mode: 'on-device', onDeviceModel: 'moonshine-tiny' } })
  const started = Date.now()
  await page.evaluate(async () => {
    const { useVoice } = (window as unknown as { __marker: { useVoice: { getState(): { prepareModel(): Promise<void> } } } }).__marker
    await useVoice.getState().prepareModel()
  })
  console.log(`model ready after ${Date.now() - started} ms`)
  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.down('Space')
  await page.waitForTimeout(3200)
  await page.keyboard.up('Space')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  const released = Date.now()
  const input = page.getByLabel('Describe a change to the board')
  await expect(input).toHaveValue(/database/i, { timeout: 60_000 })
  console.log(`transcribed in ${Date.now() - released} ms: ${await input.inputValue()}`)
})
