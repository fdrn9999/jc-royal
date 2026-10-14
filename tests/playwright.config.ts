import { defineConfig, devices } from '@playwright/test';

const channel = process.env.PW_CHANNEL; // e.g. "chrome" when Playwright's own Chromium is unavailable
const isWin = process.platform === 'win32';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:8798',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) }, testIgnore: /mobile.spec.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `pnpm --filter @jc/web build && pnpm --filter @jc/admin build && node tests/e2e/server.mjs`,
      cwd: '..',
      url: 'http://127.0.0.1:8798/api/health',
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node ${isWin ? 'node_modules/vite/bin/vite.js' : 'node_modules/vite/bin/vite.js'} preview --port 5174 --strictPort`,
      cwd: '../apps/admin',
      env: { JC_API_ORIGIN: 'http://127.0.0.1:8798' },
      url: 'http://localhost:5174',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
