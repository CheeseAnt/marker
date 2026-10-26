import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { freshApp, setBoardText } from './helpers'

const BOARD = `board "Shop" v1

node lb "Load balancer" rect at(80,40) size(200,60)
node box "Web" rect at(300,200) size(160,80)
text note "nginx 1.27" below(box,10)
edge e1 lb -> box
`

type Full = {
  board: {
    elements: { id: string; kind: string; template?: string; to?: { id: string; port?: string } }[]
    definitions: Record<string, unknown>
  }
}
const state = (page: Page) =>
  page.evaluate(() => (window as unknown as { __boardbot: { useBoard: { getState(): unknown } } }).__boardbot.useBoard.getState()) as Promise<Full>

test('save a selection as a template, add copies, detach one, and keep it all after reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await freshApp(page)
  await setBoardText(page, BOARD)
  await page.waitForTimeout(400)

  // Box-select the web server and its note.
  const canvas = (await page.locator('canvas.interactive').boundingBox())!
  await page.mouse.move(canvas.x + 270, canvas.y + 170)
  await page.mouse.down()
  await page.mouse.move(canvas.x + 560, canvas.y + 345, { steps: 6 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Templates', exact: true }).click()
  await expect(page.getByText('Select shapes on the board and save them as a template')).toBeVisible()
  await page.getByRole('button', { name: 'Save selection as template' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save as template' })
  await dialog.getByLabel('Name', { exact: true }).fill('Web server')
  await expect(dialog.getByText('Appears in the board text as web_server@1.')).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Web' }).first()).toBeChecked()
  await page.screenshot({ path: 'e2e/screenshots/template-save.png' })
  await dialog.getByRole('button', { name: 'Save template' }).click()
  await expect(dialog).toBeHidden()

  let s = await state(page)
  expect(s.board.elements.map((e) => e.id)).toEqual(['lb', 'e1', 'web_server1'])
  expect(s.board.elements.find((e) => e.id === 'e1')?.to).toEqual({ id: 'web_server1', port: 'in' })

  // Add a second copy from the library.
  await page.getByRole('button', { name: 'Add to board' }).click()
  s = await state(page)
  expect(s.board.elements.filter((e) => e.kind === 'instance').map((e) => e.id)).toEqual(['web_server1', 'web_server2'])
  await expect(page.locator('.template-entry')).toContainText('2 copies on this board.')
  await expect(page.locator('.template-preview svg')).toHaveCount(1)
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'e2e/screenshots/template-panel.png' })

  // Ungrouping a copy detaches it into ordinary shapes.
  await page.getByRole('button', { name: 'Templates', exact: true }).click()
  await page.mouse.click(canvas.x + 310, canvas.y + 210)
  await page.keyboard.press('ControlOrMeta+Shift+g')
  await expect.poll(async () => (await state(page)).board.elements.some((e) => e.id === 'web_server1')).toBe(false)
  s = await state(page)
  expect(s.board.elements.some((e) => e.id === 'web_server1_box' && e.kind === 'node')).toBe(true)
  expect(s.board.elements.find((e) => e.id === 'e1')?.to).toEqual({ id: 'web_server1_box' })

  // Library, board and its embedded template survive a reload.
  await page.waitForTimeout(600)
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await page.waitForTimeout(400)
  s = await state(page)
  expect(Object.keys(s.board.definitions)).toEqual(['web_server@1'])
  await page.getByRole('button', { name: 'Templates', exact: true }).click()
  await expect(page.locator('.template-name')).toHaveText('Web server web_server, version 1')
  await page.getByRole('button', { name: 'Board text' }).click()
  await expect(page.getByRole('textbox', { name: 'Board text' })).toHaveValue(/use web_server2 web_server@1 at\(.*\n[\s\S]*define web_server@1 \{\n {2}board "Web server" v1\n {2}template web_server\n {2}param name "Web"\n {2}port in box center/)
  // The library exports to a file that lists every version.
  await page.getByRole('button', { name: 'Templates', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export library' }).click()
  const exported = JSON.parse(readFileSync(await (await download).path(), 'utf8'))
  expect(exported).toMatchObject({ schema: 'boardbot-library', templates: [{ name: 'web_server', versions: [{ version: 1 }] }] })
  expect(errors).toEqual([])
})
