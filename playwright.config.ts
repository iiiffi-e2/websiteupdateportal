import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3000 --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATA_DIR: ".data-e2e",
      AUTH_SECRET: "e2e-auth-secret-not-for-production",
      SEED_DEMO: "true",
      DEPLOY_PROVIDER: "local_preview",
      LOCAL_ALLOWED_REPO: "lumen-studio",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
