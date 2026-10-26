import { expect, test } from '@playwright/test'
import { freshApp, setBoardText } from './helpers'

test('the theme can be switched from the menu and is kept across reloads', async ({ page }) => {
  await freshApp(page)
  await setBoardText(page, 'board "T" v1\n\nnode api "API" rect at(200,150) size(160,70) fill=#a5d8ff\nnode db "Orders" cylinder below(api,90)\nedge e1 api -> db "queries"\n')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.locator('.main-menu-trigger').click()
  await page.locator('.dropdown-menu-item', { hasText: /^Dark$/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.excalidraw.theme--dark')).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('marker.settings')!).theme)).toBe('dark')
  await page.screenshot({ path: 'e2e/screenshots/theme-dark.png' })

  // Applied before the app starts, so the page never shows light first.
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1a1d21')

  await page.getByRole('button', { name: 'Usage' }).click()
  await page.screenshot({ path: 'e2e/screenshots/theme-dark-usage.png' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark')
  await page.screenshot({ path: 'e2e/screenshots/theme-dark-settings.png' })
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('light')
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})
