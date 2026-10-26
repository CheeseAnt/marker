import { expect, test } from '@playwright/test'

test('the production build runs under its content security policy without violations', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text())
  })
  await page.goto('/')
  await page.evaluate(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to ${e.violatedDirective}: ${e.blockedURI}`))
  })
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("default-src 'self'")
  await page.locator('.excalidraw').waitFor()

  // Draw something so fonts, images and the canvas all get used.
  await page.getByRole('button', { name: 'Board text' }).click()
  await page.getByRole('textbox', { name: 'Board text' }).fill('board "CSP" v1\n\nnode a "Hand-drawn text" rect at(100,100)\ntext t "code" at(100,250) font=mono\n')
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.waitForTimeout(1500)
  await expect(page.locator('.excalidraw')).toBeVisible()
  expect(await page.evaluate(() => document.fonts.check('20px "Excalifont"'))).toBe(true)
  expect(violations).toEqual([])
})
