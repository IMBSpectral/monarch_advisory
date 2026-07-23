import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the running dev server (http://localhost:8082).
 * The `setup` project logs in once and saves the session; every other test
 * reuses it, so the suite runs authenticated without re-typing credentials.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // Start a dedicated test server on a fixed port (reusing one already up), so
  // the suite is self-contained and doesn't depend on a hand-started dev server.
  webServer: {
    command: "bun run dev -- --port 8082 --strictPort",
    url: "http://localhost:8082",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://localhost:8082",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
});
