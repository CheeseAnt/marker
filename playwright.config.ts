import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  // e2e/preview runs against the production build (playwright.preview.config.ts).
  testIgnore: 'preview/**',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5199', viewport: { width: 1280, height: 800 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: { command: 'npm run dev -- --port 5199 --strictPort', url: 'http://localhost:5199', reuseExistingServer: true },
})
