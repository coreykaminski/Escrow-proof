import { defineConfig } from "@playwright/test";

/** Browser tests (MASTER_PLAN §8 test layer 6): npm run test:e2e. */
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:8799", trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: "http://localhost:8799/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
