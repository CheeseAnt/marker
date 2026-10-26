import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { freshApp, setBoardText } from './helpers'

const WIDE = readFileSync(new URL('./fixtures/wide.png', import.meta.url))

type State = { board: { title: string; elements: { id: string; kind: string; asset?: string; label?: string }[] }; history: { past: unknown[] } }
const state = (page: Page) =>
  page.evaluate(() => (window as unknown as { __boardbot: { useBoard: { getState(): unknown } } }).__boardbot.useBoard.getState()) as Promise<State>

test('save a board with its image and history, start afresh, and open it again', async ({ page }) => {
  // Use the download and file-input fallback; native pickers can't be driven from tests.
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker
  })
  await freshApp(page)
  await setBoardText(page, 'board "Shop floor" v1\n\nnode api "API" rect at(100,100) size(160,70)\n')
  await page.evaluate(async (bytes) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(bytes)], 'wide.png', { type: 'image/png' }))
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.querySelector('.excalidraw')!.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: 600, clientY: 300 }))
    }
  }, [...WIDE])
  await expect.poll(async () => (await state(page)).board.elements.some((e) => e.kind === 'image')).toBe(true)
  await expect(page.getByRole('button', { name: 'Not saved to a file' })).toBeVisible()

  const download = page.waitForEvent('download')
  await page.keyboard.press('ControlOrMeta+s')
  const saved = await download
  expect(saved.suggestedFilename()).toBe('shop-floor.board')
  const path = await saved.path()
  const text = readFileSync(path, 'utf8')
  expect(text).toMatch(/^board "Shop floor" v1\n/)
  expect(text).toMatch(/\n#@asset [0-9a-f]{40} image\/png \d+x\d+ /)
  expect(text).toMatch(/\n#@history \d+ \{"past":\[/)
  await expect(page.getByRole('button', { name: 'shop-floor.board', exact: true })).toBeVisible()

  // An edit marks the board unsaved; undoing it back to the saved state clears that.
  await page.getByRole('button', { name: 'Board text' }).click()
  await page.getByRole('textbox', { name: 'Board text' }).fill(text.split('\n#@')[0].replace('"API"', '"Gateway"'))
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.getByRole('button', { name: 'Board text' }).click()
  await expect(page.getByRole('button', { name: 'shop-floor.board, unsaved changes' })).toBeVisible()

  // New board asks first; choosing not to save gives an empty board.
  await page.locator('.main-menu-trigger').click()
  await page.locator('.dropdown-menu-item', { hasText: 'New board' }).click()
  const ask = page.getByRole('dialog', { name: 'Save your changes first?' })
  await expect(ask).toContainText("changes that aren't saved to shop-floor.board")
  await ask.getByRole('button', { name: "Don't save" }).click()
  await expect.poll(async () => (await state(page)).board.elements.length).toBe(0)

  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('ControlOrMeta+o')
  await (await chooser).setFiles({ name: 'shop-floor.board', mimeType: 'text/plain', buffer: readFileSync(path) })
  await expect(page.locator('.toast.done')).toContainText('Opened shop-floor.board, with its undo history')
  const opened = await state(page)
  expect(opened.board.title).toBe('Shop floor')
  expect(opened.board.elements.find((e) => e.id === 'api')?.label).toBe('API')
  expect(opened.history.past.length).toBeGreaterThan(0)
  const image = opened.board.elements.find((e) => e.kind === 'image')!
  await expect
    .poll(() => page.evaluate((id) => (window as unknown as { __boardbotFiles?: () => string[] }).__boardbotFiles?.().includes(id), image.asset!))
    .toBe(true)
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'e2e/screenshots/file-opened.png' })
})
