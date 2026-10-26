import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { CORS, fakeAzure, freshApp, setBoardText, toolCallStream } from './helpers'

const WIDE = readFileSync(new URL('./fixtures/wide.png', import.meta.url))

type Img = { id: string; kind: string; asset?: string; size?: { w: number; h: number } }
const elements = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __boardbot: { useBoard: { getState(): { board: { elements: unknown[] } } } } }).__boardbot.useBoard.getState().board.elements,
  ) as Promise<Img[]>

/** Drops the fixture onto an element, the way a file dragged from the desktop arrives. */
async function dropImage(page: Page, selector: string, x: number, y: number) {
  await page.evaluate(
    async ({ selector, x, y, bytes }) => {
      const file = new File([new Uint8Array(bytes)], 'wide.png', { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(file)
      const target = document.querySelector(selector)!
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y }))
      }
    },
    { selector, x, y, bytes: [...WIDE] },
  )
}

test('dropped images are kept with the board and survive a reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await freshApp(page)
  await setBoardText(page, 'board "Pics" v1\n\nnode api "API" rect at(80,80) size(160,70)\n')
  await page.waitForTimeout(300)

  await dropImage(page, '.excalidraw', 500, 300)
  await expect.poll(async () => (await elements(page)).filter((e) => e.kind === 'image').length, { timeout: 8000 }).toBe(1)
  const image = (await elements(page)).find((e) => e.kind === 'image')!
  expect(image.asset).toMatch(/^[0-9a-f]{40}$/)
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'e2e/screenshots/image-dropped.png' })

  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await expect.poll(async () => (await elements(page)).find((e) => e.kind === 'image')?.asset).toBe(image.asset)
  // The bytes come back from storage, so the canvas has the file to draw.
  await expect
    .poll(() => page.evaluate((id) => !!document.querySelector('.excalidraw') && (window as unknown as { __boardbotFiles?: () => string[] }).__boardbotFiles?.().includes(id), image.asset!))
    .toBe(true)
  expect(errors).toEqual([])
})

test('images attached to a request are downscaled, shown to the model, and can be placed', async ({ page }) => {
  await freshApp(page, { configured: true })
  await setBoardText(page, 'board "Pics" v1\n\nnode api "API" rect at(80,80) size(160,70)\n')

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach images' }).click()
  await (await chooser).setFiles({ name: 'wide.png', mimeType: 'image/png', buffer: WIDE })
  await expect(page.getByRole('list', { name: 'Attached images' }).getByRole('listitem')).toHaveCount(1)
  await page.screenshot({ path: 'e2e/screenshots/image-attached.png' })

  // The fake model answers with whatever asset id the request listed.
  const bodies = await fakeAzure(page, (route, body) => {
    const text = JSON.stringify((body.messages as { content: unknown }[])[1].content)
    const asset = text.match(/asset ([0-9a-f]{40}), (\d+)x(\d+)/)!
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream' },
      body: toolCallStream('edit_board', { summary: 'Placed the banner', ops: [{ op: 'add_image', id: 'banner', asset: asset[1] }] }),
    })
  })
  const input = page.getByLabel('Describe a change to the board')
  await input.fill('put this banner next to the API')
  await input.press('Enter')
  await expect(page.locator('.toast.done')).toContainText('Placed the banner')

  const content = (bodies.at(-1) as unknown as { messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] }).messages[1].content
  expect(content.map((p) => p.type)).toEqual(['text', 'image_url'])
  expect(content[0].text).toMatch(/1\. "wide.png" \(asset [0-9a-f]{40}, 1568x784\)/)
  expect(content[1].image_url!.url).toMatch(/^data:image\/png;base64,/)
  const banner = (await elements(page)).find((e) => e.id === 'banner')!
  expect(banner).toMatchObject({ kind: 'image', size: { w: 320, h: 160 } })
  await expect(page.getByRole('list', { name: 'Attached images' })).toHaveCount(0)
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'e2e/screenshots/image-placed.png' })
})
