import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = "e2e/.auth/user.json";

setup("authenticate", async ({ page }) => {
  // Retry the whole flow: on a cold dev server the first click can fire before
  // the client bundle hydrates, causing a native form submit that never posts.
  // Re-goto + re-submit until the login actually lands on the dashboard.
  await expect(async () => {
    await page.goto("/login");
    await page.locator("input").first().fill("founder@imblabs.example");
    await page.locator('input[type="password"]').fill("monarch-demo-2026");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("http://localhost:8082/", { timeout: 5_000 });
  }).toPass({ timeout: 40_000 });
  await expect(page.getByText("Executive Dashboard")).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
