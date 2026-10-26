import { expect, test, type Page } from '@playwright/test'

const BOARD = `board "History check" v1

node api "API Gateway" rect at(200,150) size(180,70) fill=#e3f2fd
node db "Postgres" ellipse below(api,90)
edge e1 api -> db "queries"
`

type State = { board: { elements: { id: string; at?: { x: number } }[] }; history: { past: { title: string }[]; future: unknown[] } }

const state = (page: Page) =>
  page.evaluate(() => (window as unknown as { __marker: { useBoard: { getState(): unknown } } }).__marker.useBoard.getState()) as Promise<State>

const apiX = async (page: Page) => (await state(page)).board.elements.find((e) => e.id === 'api')?.at?.x

test('undo, redo, history panel and persistence', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.evaluate(() => indexedDB.deleteDatabase('keyval-store'))
  await page.reload()
  await expect(page.locator('.excalidraw')).toBeVisible()
  const undoButton = page.getByRole('button', { name: 'Undo', exact: true }).first()
  await expect(undoButton).toBeDisabled()

  await page.getByRole('button', { name: 'Board text' }).click()
  await page.getByRole('textbox', { name: 'Board text' }).fill(BOARD)
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.getByRole('button', { name: 'Board text' }).click()
  await page.waitForTimeout(500)

  const box = (await page.locator('canvas.interactive').boundingBox())!
  await page.mouse.move(box.x + 210, box.y + 165)
  await page.mouse.down()
  await page.mouse.move(box.x + 310, box.y + 165, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  expect(await apiX(page)).toBe(300)
  expect((await state(page)).history.past.map((t) => t.title)).toEqual(['Added 3 elements', 'Moved “API Gateway”'])

  // Keyboard undo and redo work while the canvas has focus.
  await page.mouse.click(box.x + 600, box.y + 500)
  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForTimeout(300)
  expect(await apiX(page)).toBe(200)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await page.waitForTimeout(300)
  expect(await apiX(page)).toBe(300)

  // The history panel lists changes and jumps between them.
  await page.getByRole('button', { name: 'History' }).click()
  const rows = page.getByRole('list', { name: 'Changes, newest first' }).getByRole('button')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'step')
  await rows.filter({ hasText: 'Before these changes' }).click()
  await page.waitForTimeout(300)
  expect((await state(page)).board.elements).toEqual([])
  await page.screenshot({ path: 'e2e/screenshots/history-start.png' })
  await rows.filter({ hasText: 'Added 3 elements' }).click()
  await page.waitForTimeout(300)
  expect(await apiX(page)).toBe(200)
  await page.screenshot({ path: 'e2e/screenshots/history.png' })

  // Footer button undoes too.
  await undoButton.click()
  await page.waitForTimeout(300)
  expect((await state(page)).board.elements).toEqual([])

  // History survives a reload.
  await page.waitForTimeout(600)
  await page.reload()
  await expect(page.locator('.excalidraw')).toBeVisible()
  await page.waitForTimeout(500)
  const reloaded = await state(page)
  expect(reloaded.history.past).toHaveLength(0)
  expect(reloaded.history.future).toHaveLength(2)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await page.waitForTimeout(300)
  expect(await apiX(page)).toBe(200)
  expect(errors).toEqual([])
})
