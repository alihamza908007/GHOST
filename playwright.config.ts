import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.GHOST_API_URL || 'http://localhost:3002',
  },
  webServer: {
    command: 'npm run dev:server',
    url: 'http://localhost:3002/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
