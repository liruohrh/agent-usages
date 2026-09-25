/**
 * Playwright configuration for the dashboard's end-to-end tests.
 *
 * One server, one data set: the offline snapshot when it exists (deterministic
 * numbers), a live scan otherwise — see `scripts/e2e-server.mjs`. The browser is
 * the system Chrome by default (`PW_CHANNEL=chromium` after
 * `npx playwright install chromium` uses the bundled one instead).
 */

import { defineConfig, devices } from '@playwright/test';

/** The port the tests and the server agree on. */
const PORT = Number(process.env.E2E_PORT ?? 4317);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // The server holds one data set and the pages are cheap; one worker keeps the
  // numbers in the assertions from racing a parallel scan.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120_000,
    stdout: 'pipe',
  },
});
