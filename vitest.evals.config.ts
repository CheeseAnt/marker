import { defineConfig } from 'vitest/config'

/** Model evals (evals/eval.test.ts), kept apart from the unit tests. */
export default defineConfig({
  test: {
    include: ['evals/**/*.test.ts'],
    testTimeout: 180_000,
    server: { deps: { inline: ['@excalidraw/excalidraw'] } },
  },
})
