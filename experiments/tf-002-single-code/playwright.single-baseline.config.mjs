import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: 'http://127.0.0.1:5319',
    headless: true,
    viewport: {width: 480, height: 480},
  },
  webServer: {
    command: 'npm run dev:single-baseline-sender',
    url: 'http://127.0.0.1:5319/single-baseline.html',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
