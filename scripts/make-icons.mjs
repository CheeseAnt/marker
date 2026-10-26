import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
// Renders the PNG app icons from public/icons/icon.svg: node scripts/make-icons.mjs
const root = process.cwd()
const svg = readFileSync(`${root}/public/icons/icon.svg`, 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [size, name, pad] of [[192, 'icon-192.png', 0], [512, 'icon-512.png', 0], [512, 'icon-maskable-512.png', 0.1], [180, 'apple-touch-icon.png', 0]]) {
  await page.setViewportSize({ width: size, height: size })
  const inset = Math.round(size * pad)
  // Maskable icons need their content inside the middle 80%, on a full-bleed background.
  await page.setContent(`<html><body style="margin:0;background:#f6f7f5"><div style="padding:${inset}px;width:${size - inset * 2}px;height:${size - inset * 2}px">${svg.replace('<svg ', `<svg width="${size - inset * 2}" height="${size - inset * 2}" `)}</div></body></html>`)
  await page.screenshot({ path: `${root}/public/icons/${name}`, omitBackground: pad === 0 })
}
await browser.close()
