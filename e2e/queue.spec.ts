import { expect, test, type Page } from '@playwright/test'
import { CORS, fakeAzure, freshApp, setBoardText, toolCallStream } from './helpers'

const stream = (body: string) => ({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body })

const elements = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __marker: { useBoard: { getState(): { board: { elements: unknown[] } } } } }).__marker.useBoard.getState().board.elements,
  ) as Promise<{ id: string; at?: { x: number; y: number } }[]>

test('two requests run at once, the panel shows them, and unconnected results land mid-view', async ({ page }) => {
  const held: (() => void)[] = []
  await fakeAzure(page, async (route, body) => {
    const content = String((body.messages as { content: string }[])[1].content)
    const request = content.slice(content.lastIndexOf('Request: ') + 9)
    // Hold each answer until the test lets it go.
    await new Promise<void>((r) => held.push(r))
    const id = request.includes('note') ? 'note' : request.includes('third') ? 'third' : 'box'
    return route.fulfill(stream(toolCallStream('edit_board', { summary: `Added ${id}`, ops: [{ op: 'add_node', id, label: id, size: { w: 120, h: 60 } }] })))
  })
  await freshApp(page, { configured: true })
  await setBoardText(page, 'board "Q" v1\n\nnode far "Far away" rect at(-2000,-2000)\n')

  const input = page.getByLabel('Describe a change to the board')
  for (const request of ['add a box', 'add a note', 'add a third thing']) {
    await input.fill(request)
    await input.press('Enter')
  }
  await expect.poll(() => held.length).toBe(2)
  await expect(page.locator('.job-status')).toContainText('2 more')
  await page.locator('.job-status').click()
  const panel = page.getByRole('dialog', { name: 'Requests' })
  await expect(panel.locator('.queue-row')).toHaveCount(3)
  await expect(panel.locator('.queue-row.queued .queue-state')).toHaveText('Waiting')
  await expect(panel.locator('.queue-progress')).toHaveCount(2)
  await page.screenshot({ path: 'e2e/screenshots/queue-panel.png' })

  held.shift()!()
  held.shift()!()
  await expect(panel.locator('.queue-row.done')).toHaveCount(2)
  await expect.poll(() => held.length).toBe(1)
  held.shift()!()
  await expect(panel.locator('.queue-row.done')).toHaveCount(3)

  // Both new nodes are in the middle of the view, not at the far element or the top left.
  const view = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.interactive')!.getBoundingClientRect()
    return { w: canvas.width, h: canvas.height }
  })
  const els = await elements(page)
  for (const id of ['box', 'note']) {
    const at = els.find((e) => e.id === id)!.at!
    expect(Math.abs(at.x + 60 - view.w / 2)).toBeLessThan(260)
    expect(Math.abs(at.y + 30 - view.h / 2)).toBeLessThan(260)
  }
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})
