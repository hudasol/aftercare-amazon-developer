import { defineConfig, devices } from '@playwright/test';

const PORT = 8790;

export default defineConfig({
  testDir: 'e2e',
  // Tests share one server and reset the demo, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } },
    },
  ],
  webServer: {
    command: 'npm run build:web && node --import tsx src/main.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      DATABASE_PATH: 'var/e2e/aftercare-e2e.db',
      SANDBOX_LATENCY_MS: '60',
      SANDBOX_TIMEOUT_MS: '300',
    },
  },
});
