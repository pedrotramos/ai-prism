// Playwright config for the e2e/a11y harness (client/e2e). The browser runs
// the BUILT client (client/dist) behind client/e2e/fixture-server.mjs, which
// answers /api/* from recorded fixtures: no backend, database or AI Gateway.
//
//   npm run build:client && npm run test:e2e
//   E2E_STRICT=1 npm run test:e2e            # also fail on any serious/critical axe node
//   E2E_UPDATE_BASELINE=1 npm run test:e2e   # rewrite client/e2e/baseline.json for this OS
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT || 4173)

export default defineConfig({
  testDir: 'client/e2e',
  testMatch: '*.spec.mjs',
  outputDir: 'client/e2e/.output/test-results',
  // one worker: the a11y spec is serial and its numbers must not depend on CPU contention
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['html', { outputFolder: 'client/e2e/.output/report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node client/e2e/fixture-server.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
