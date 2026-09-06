import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: 'http://127.0.0.1:5190',
    headless: true,
    viewport: {width: 1440, height: 1100},
  },
  webServer: {
    command: 'npm run dev -- --port 5190',
    url: 'http://127.0.0.1:5190/carrier-bench.html',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
