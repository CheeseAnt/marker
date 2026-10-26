import { expect, test, type Page } from '@playwright/test'

const BOARD = `board "Sync check" v1

node api "API Gateway" rect at(200,150) size(180,70) fill=#e3f2fd
node db "Postgres" ellipse below(api,90)
edge e1 api -> db "queries"
text t1 "hand-drawn notes" at(480,160)
`

const boardText = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __boardbot: { useBoard: { getState(): { board: unknown; revision: number } } } }
    return w.__boardbot.useBoard.getState()
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
  await expect(page.getByRole('textbox', { name: 'Board text' })).toHaveValue(BOARD)
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
  const after = (await boardText(page)).board as { elements: { id: string; at?: { x: number } }[] }
  expect(after.elements.find((e) => e.id === 'api')?.at?.x).toBeCloseTo(300, 0)
  await page.screenshot({ path: 'e2e/screenshots/dragged.png' })

  await page.waitForTimeout(600)
  await page.reload()
  await expect(page.locator('.excalidraw')).toBeVisible()
  await page.waitForTimeout(800)
  const diag = await page.evaluate(async () => {
    const w = window as unknown as { __boardbot: { useBoard: { getState(): { revision: number; lastSource: string } } } }
    const req = indexedDB.open('keyval-store')
    const text = await new Promise((res) => {
      req.onsuccess = () => {
        const get = req.result.transaction('keyval').objectStore('keyval').get('boardbot.board.v1')
        get.onsuccess = () => res(get.result)
      }
    })
    const { revision, lastSource } = w.__boardbot.useBoard.getState()
    return { revision, lastSource, text }
  })
  console.log(JSON.stringify(diag))
  const reloaded = (await boardText(page)).board as { title: string; elements: unknown[] }
  expect(reloaded.title).toBe('Sync check')
  expect(reloaded.elements).toEqual(after.elements)
  expect(errors).toEqual([])
})
