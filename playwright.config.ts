import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.STACK40_E2E_PORT ?? 4173);
const host = '127.0.0.1';
const baseURL = `http://${host}:${port}`;
const useSystemChrome = process.env.STACK40_E2E_BROWSER === 'chrome';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './.codex-output/playwright',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: useSystemChrome ? 'system-chrome' : 'chromium',
      use: useSystemChrome
        ? { ...devices['Desktop Chrome'], channel: 'chrome' }
        : { ...devices['Desktop Chrome'] },
    },
  ],
});
