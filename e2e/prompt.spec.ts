import { expect, test } from '@playwright/test'
import { boardState, CORS, fakeAzure, freshApp, setBoardText, toolCallStream } from './helpers'

const BOARD = `board "Shop" v1

node api "API" rect at(200,150) size(160,70)
node db "Orders DB" ellipse below(api,90)
edge e1 api -> db
`

const stream = (body: string) => ({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body })

test('a typed request edits the board as one undoable step', async ({ page }) => {
  const bodies = await fakeAzure(page, (route) =>
    route.fulfill(
      stream(
        toolCallStream('edit_board', {
          summary: 'Added a cache beside the API',
          ops: [
            { op: 'add_node', id: 'cache', label: 'Cache', shape: 'rect', place: { rel: 'right', of: 'api', gap: 120 }, style: { fill: '#ffec99' } },
            { op: 'add_edge', from: 'api', to: 'cache', label: 'reads' },
          ],
        }),
      ),
    ),
  )
  await freshApp(page, { configured: true })
  await setBoardText(page, BOARD)

  // Select the API node so the request can say "it".
  const box = (await page.locator('canvas.interactive').boundingBox())!
  await page.mouse.click(box.x + 205, box.y + 155)
  await page.keyboard.press('/')
  await page.keyboard.type('add a yellow cache to the right of it')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('status').filter({ hasText: 'Added a cache beside the API' })).toBeVisible()
  // The new node and edge get a passing highlight instead of being selected.
  await expect(page.locator('.change-highlight')).not.toHaveCount(0)
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'e2e/screenshots/prompt-highlight.png' })
  await expect(page.locator('.change-highlight')).toHaveCount(0, { timeout: 3000 })
  const state = await boardState(page)
  expect(state.board.elements.find((e) => e.id === 'cache')).toMatchObject({ label: 'Cache', style: { fill: '#ffec99' } })
  expect(state.history.past.at(-1)).toMatchObject({ title: 'Added a cache beside the API', prompt: 'add a yellow cache to the right of it', source: 'ai' })
  expect(String((bodies[0].messages as { content: string }[])[1].content)).toContain('Selected: api')
  await expect(page.getByLabel('Describe a change to the board')).toHaveValue('')
  await expect(page.getByRole('button', { name: /^This session: / })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/prompt-done.png' })

  // The history panel shows the request in handwriting above the title.
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.locator('.history-row.current .history-prompt')).toHaveText('add a yellow cache to the right of it')
  await page.screenshot({ path: 'e2e/screenshots/prompt-history.png' })

  await page.getByRole('button', { name: 'Undo', exact: true }).last().click()
  await expect.poll(async () => (await boardState(page)).board.elements.some((e) => e.id === 'cache')).toBe(false)
})

test('answers, repairs and cancellation', async ({ page }) => {
  let release: () => void = () => {}
  const hold = new Promise<void>((r) => (release = r))
  await fakeAzure(page, async (route, body, n) => {
    const content = String((body.messages as { content: string }[])[1].content)
    const prompt = content.slice(content.lastIndexOf('Request: '))
    if (prompt.includes('how many')) return route.fulfill(stream(toolCallStream('reply', { message: 'There are two nodes.' })))
    if (prompt.includes('slow')) {
      await hold
      return route.fulfill(stream(toolCallStream('reply', { message: 'late' }))).catch(() => {})
    }
    // A first answer that references a missing node, then a corrected one.
    const messages = body.messages as { role: string }[]
    if (messages.at(-1)?.role !== 'tool') {
      return route.fulfill(stream(toolCallStream('edit_board', { summary: 'Linked queue', ops: [{ op: 'add_edge', from: 'api', to: 'queue' }] })))
    }
    expect(n).toBeGreaterThan(1)
    return route.fulfill(
      stream(
        toolCallStream('edit_board', {
          summary: 'Added a queue',
          ops: [
            { op: 'add_node', id: 'queue', label: 'Queue' },
            { op: 'add_edge', from: 'api', to: 'queue' },
          ],
        }),
      ),
    )
  })
  await freshApp(page, { configured: true })
  await setBoardText(page, BOARD)
  const input = page.getByLabel('Describe a change to the board')

  await input.fill('how many nodes are there?')
  await input.press('Enter')
  await expect(page.locator('.toast.reply')).toContainText('There are two nodes.')
  expect((await boardState(page)).history.past).toHaveLength(1)

  await input.fill('connect the api to a queue')
  await input.press('Enter')
  await expect(page.locator('.toast.done')).toContainText('Added a queue')
  expect((await boardState(page)).board.elements.find((e) => e.id === 'queue')).toMatchObject({ at: { kind: 'at' } })

  await input.fill('a slow one')
  await input.press('Enter')
  await expect(page.locator('.job-status')).toContainText('Working out')
  await expect(page.locator('.ledge[data-busy]')).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/prompt-busy.png' })
  await page.locator('.job-status').click()
  await page.getByRole('dialog', { name: 'Requests' }).getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog', { name: 'Requests' }).locator('.queue-row.cancelled')).toContainText('a slow one')
  release()
  await expect(page.locator('.ledge[data-busy]')).toBeHidden()
})

test('follow-ups: "yes, do that" and "undo that and do it another way"', async ({ page }) => {
  await fakeAzure(page, (route, body) => {
    const content = String((body.messages as { content: string }[])[1].content)
    const request = content.slice(content.lastIndexOf('Request: ') + 9)
    if (request.startsWith('what would')) {
      return route.fulfill(stream(toolCallStream('reply', { message: 'A cache between the API and the database would help. Shall I add one?' })))
    }
    if (request.startsWith('yes')) {
      // The model only knows what "that" is from the recent conversation.
      expect(content).toContain('You replied: "A cache between the API and the database would help. Shall I add one?"')
      return route.fulfill(
        stream(toolCallStream('edit_board', { summary: 'Added a cache', ops: [{ op: 'add_node', id: 'cache', label: 'Cache', place: { rel: 'right', of: 'api' } }, { op: 'add_edge', from: 'api', to: 'cache' }] })),
      )
    }
    expect(content).toMatch(/Recent changes to the board, newest first.*\n1\. Request "yes, do that": Added a cache \(cache, api_cache\)/)
    return route.fulfill(
      stream(
        toolCallStream('edit_board', {
          summary: 'Added a queue instead of the cache',
          undo_first: 1,
          ops: [{ op: 'add_node', id: 'queue', label: 'Queue', shape: 'diamond', place: { rel: 'right', of: 'api' } }, { op: 'add_edge', from: 'api', to: 'queue' }],
        }),
      ),
    )
  })
  await freshApp(page, { configured: true })
  await setBoardText(page, BOARD)
  const input = page.getByLabel('Describe a change to the board')
  const ids = async () => (await boardState(page)).board.elements.map((e) => e.id)

  await input.fill('what would improve this?')
  await input.press('Enter')
  await expect(page.locator('.toast.reply')).toContainText('Shall I add one?')

  await input.fill('yes, do that')
  await input.press('Enter')
  await expect(page.locator('.toast.done')).toContainText('Added a cache')
  expect(await ids()).toContain('cache')

  await input.fill('undo that and use a queue instead')
  await input.press('Enter')
  await expect(page.locator('.toast.done')).toContainText('Added a queue instead of the cache')
  expect(await ids()).toEqual(['api', 'db', 'e1', 'queue', 'api_queue'])
  const { history } = (await boardState(page)) as unknown as { history: { past: { title: string }[]; future: unknown[] } }
  expect(history.past.map((t) => t.title)).toEqual(['Added 3 elements', 'Added a queue instead of the cache'])
  expect(history.future).toEqual([])

  // Undoing the replacement goes back to before the cache, not to the cache.
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(ids).toEqual(['api', 'db', 'e1'])
})
