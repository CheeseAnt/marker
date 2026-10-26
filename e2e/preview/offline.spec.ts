import { expect, test } from '@playwright/test'

test('after one visit the app opens and works offline, isolated by its service worker', async ({ page, context }) => {
  await page.goto('/')
  await page.locator('.excalidraw').waitFor()
  await page.evaluate(() => navigator.serviceWorker.ready)
  // The first load may reload once so the service worker controls the page.
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true)
  await page.getByRole('button', { name: 'Board text' }).click()
  await page.getByRole('textbox', { name: 'Board text' }).fill('board "Offline" v1\n\nnode a "Works offline" rect at(100,100)\n')
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.waitForTimeout(800)

  await context.setOffline(true)
  await page.reload()
  await page.locator('.excalidraw').waitFor()
  await page.getByRole('button', { name: 'Board text', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Board text' })).toHaveValue(/node a "Works offline"/)
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  expect(await page.evaluate(() => document.fonts.check('20px "Excalifont"'))).toBe(true)
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifest).toBeTruthy()
  await context.setOffline(false)
})
