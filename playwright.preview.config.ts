import { defineConfig, devices } from '@playwright/test'

/** Checks against the production build (`npm run build` first), served by `vite preview`. */
export default defineConfig({
  testDir: 'e2e/preview',
  timeout: 240_000,
  use: { baseURL: 'http://localhost:5198', viewport: { width: 1280, height: 800 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: { command: 'npx vite preview --port 5198 --strictPort', url: 'http://localhost:5198', reuseExistingServer: false },
})
