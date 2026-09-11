import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 360_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: 'http://127.0.0.1:5317',
    headless: true,
    viewport: {width: 1440, height: 1100},
  },
  webServer: {
    command: 'npm run dev:tf008-sender',
    url: 'http://127.0.0.1:5317/tiled-physical-v5.html?role=sender&standalone=file',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
