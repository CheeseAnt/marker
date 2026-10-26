import { expect, test, type Page } from '@playwright/test'

const BOARD = `board "Sync check" v1

node api "API Gateway" rect at(200,150) size(180,70) fill=#e3f2fd
node db "Postgres" ellipse below(api,90)
edge e1 api -> db "queries"
text t1 "hand-drawn notes" at(480,160)
`

const boardText = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __marker: { useBoard: { getState(): { board: unknown; revision: number } } } }
    return w.__marker.useBoard.getState()
  })

async function applyText(page: Page, text: string) {
  await page.getByRole('button', { name: 'Board text' }).click()
  const area = page.getByRole('textbox', { name: 'Board text' })
  await area.fill(text)
  await page.getByRole('button', { name: 'Apply' }).click()
}

test('board text renders, stays stable, picks up drags, and survives reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.evaluate(() => indexedDB.deleteDatabase('keyval-store'))
  await page.reload()
  await expect(page.locator('.excalidraw')).toBeVisible()

  await applyText(page, BOARD)
  await page.waitForTimeout(1200)
  const settled = await boardText(page)
  // Rendering the board must not feed back into spurious "manual" edits.
  await page.waitForTimeout(1200)
  expect((await boardText(page)).revision).toBe(settled.revision)
  // Placing Postgres below the API gives it a position of its own.
  await expect(page.getByRole('textbox', { name: 'Board text' })).toHaveValue(/\nnode db "Postgres" ellipse at\(\d+,\d+\)\n/)
  await page.screenshot({ path: 'e2e/screenshots/board.png' })

  // Drag the API node 100px right on the canvas.
  await page.getByRole('button', { name: 'Board text' }).click()
  const canvas = page.locator('canvas.interactive')
  const box = (await canvas.boundingBox())!
  // Scene and screen coordinates line up at the default scroll and zoom.
  await page.mouse.move(box.x + 210, box.y + 165)
  await page.mouse.down()
  await page.mouse.move(box.x + 260, box.y + 165, { steps: 5 })
  await page.mouse.move(box.x + 310, box.y + 165, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  const after = (await boardText(page)).board as { elements: { id: string; at?: { x: number; y: number } }[] }
  expect(after.elements.find((e) => e.id === 'api')?.at?.x).toBeCloseTo(300, 0)
  // Postgres was placed below the API, but stays put when the API moves.
  const dbAt = (b: unknown) => (b as typeof after).elements.find((e) => e.id === 'db')?.at
  expect(dbAt(settled.board)).toMatchObject({ kind: 'at' })
  expect(dbAt(after)).toEqual(dbAt(settled.board))
  await page.screenshot({ path: 'e2e/screenshots/dragged.png' })

  await page.waitForTimeout(600)
  await page.reload()
  await expect(page.locator('.excalidraw')).toBeVisible()
  await page.waitForTimeout(800)
  const reloaded = (await boardText(page)).board as { title: string; elements: unknown[] }
  expect(reloaded.title).toBe('Sync check')
  expect(reloaded.elements).toEqual(after.elements)
  expect(errors).toEqual([])
})

test('shapes drawn by hand get short ids once the canvas is quiet', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => indexedDB.deleteDatabase('keyval-store'))
  await page.reload()
  await expect(page.locator('.excalidraw')).toBeVisible()
  const ids = async () => ((await boardText(page)).board as { elements: { id: string }[] }).elements.map((e) => e.id)

  const box = (await page.locator('canvas.interactive').boundingBox())!
  await page.getByTitle(/^Rectangle/).click()
  await page.mouse.move(box.x + 400, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + 560, box.y + 300, { steps: 5 })
  await page.mouse.up()
  await expect.poll(ids).toHaveLength(1)
  expect((await ids())[0]).not.toBe('rect1')
  await expect.poll(ids, { timeout: 6000 }).toEqual(['rect1'])
  // The drawing and its rename undo as one step.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(ids).toEqual([])
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect.poll(ids).toEqual(['rect1'])
})
