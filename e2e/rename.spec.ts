import { expect, test } from '@playwright/test'
import { boardState, freshApp } from './helpers'

const BOARD = `board "Old" v1\n\nnode api "Saved before the rename" rect at(200,150) size(200,70)\n`

test('data saved under the old name is moved to the new keys', async ({ page }) => {
  await freshApp(page)
  // Put the board and settings back where BoardBot kept them.
  await page.evaluate(async (text) => {
    localStorage.clear()
    localStorage.setItem('boardbot.settings', JSON.stringify({ voice: { mode: 'off' }, budget: { limit: 7 } }))
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('keyval-store')
      open.onsuccess = () => {
        const tx = open.result.transaction('keyval', 'readwrite')
        tx.objectStore('keyval').clear()
        tx.objectStore('keyval').put(text, 'boardbot.board.v1')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
    })
  }, BOARD)
  await page.reload()
  await page.locator('.excalidraw').waitFor()

  await expect.poll(async () => (await boardState(page)).board.elements.map((e) => e.label)).toEqual(['Saved before the rename'])
  const stored = await page.evaluate(() => ({ old: localStorage.getItem('boardbot.settings'), now: JSON.parse(localStorage.getItem('marker.settings') ?? '{}') }))
  expect(stored.old).toBeNull()
  expect(stored.now).toMatchObject({ budget: { limit: 7 } })
  const keys = await page.evaluate(
    () =>
      new Promise<IDBValidKey[]>((resolve) => {
        const open = indexedDB.open('keyval-store')
        open.onsuccess = () => {
          const req = open.result.transaction('keyval').objectStore('keyval').getAllKeys()
          req.onsuccess = () => resolve(req.result)
        }
      }),
  )
  expect(keys).toContain('marker.board.v1')
  expect(keys).not.toContain('boardbot.board.v1')
})
