import { expect, test } from '@playwright/test'
import { boardState, freshApp, setBoardText } from './helpers'

const BOARD = `board "Fonts" v1

node title "System overview" rect at(80,60) size(320,70) font=display
node api "API Gateway" rect at(80,180)
node db "Orders DB" ellipse right(api,80)
edge e1 api -> db "queries"
text t1 "GET /orders?status=open" at(80,330) font=mono
text t2 "plain note" at(80,380) font=sans
text t3 "classic sketch" at(80,430) font=virgil
`

test('board font menu sets the default; elements keep their own fonts', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await freshApp(page)
  await setBoardText(page, BOARD)
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'e2e/screenshots/fonts-before.png' })

  await page.locator('.main-menu-trigger').click()
  const item = (name: string) => page.locator('.dropdown-menu-item', { hasText: name })
  await expect(item('Hand-drawn')).toHaveClass(/selected/)
  await page.screenshot({ path: 'e2e/screenshots/fonts-menu.png' })
  await item('Rounded').click()

  await expect.poll(async () => ((await boardState(page)) as unknown as { board: { defaults: { font?: string } } }).board.defaults.font).toBe('normal')
  const state = await boardState(page)
  expect(state.history.past.at(-1)?.title).toBe('Changed the board font to Rounded')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'e2e/screenshots/fonts-after.png' })

  // Nodes without their own font follow the board; the others keep theirs.
  const families = await page.evaluate(() => {
    const w = window as unknown as { __boardbot: { useBoard: { getState(): { compiled: { elements: { id: string; fontFamily?: number }[] } } } } }
    return Object.fromEntries(w.__boardbot.useBoard.getState().compiled.elements.filter((e) => e.fontFamily).map((e) => [e.id, e.fontFamily]))
  })
  expect(families).toEqual({ 'title~label': 7, 'api~label': 6, 'db~label': 6, 'e1~label': 6, t1: 3, t2: 9, t3: 1 })

  // The board text records it, and undo restores the hand-drawn default.
  await page.getByRole('button', { name: 'Board text' }).click()
  await expect(page.getByRole('textbox', { name: 'Board text' })).toHaveValue(/^board "Fonts" v1\nstyle default font=normal\n/)
  await page.getByRole('button', { name: 'Board text' }).click()
  await page.locator('canvas.interactive').click({ position: { x: 700, y: 500 } })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => ((await boardState(page)) as unknown as { board: { defaults: { font?: string } } }).board.defaults.font).toBeUndefined()

  // Every preset's typeface actually loaded.
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready
    return ['Excalifont', 'Virgil', 'Nunito', 'Liberation Sans', 'Lilita One', 'Comic Shanns', 'Cascadia'].filter((f) => !document.fonts.check(`20px "${f}"`))
  })
  expect(loaded).toEqual([])
  expect(errors).toEqual([])
})
