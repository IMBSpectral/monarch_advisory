import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = "e2e/.auth/user.json";

// A cold dev server compiles the route + the login server-fn on first hit, and
// that first POST can take far longer than a warm one — especially on a
// resource-constrained CI runner. Give this setup a very generous budget; a warm
// login still passes in ~1s, so the ceiling only matters on the cold first run.
setup.setTimeout(300_000);

setup("authenticate", async ({ page }) => {
  // Retry the whole flow: on a cold dev server the first click can fire before
  // the client bundle hydrates, causing a native form submit that never posts.
  // Re-goto + re-submit until the login actually lands on the dashboard. The
  // per-attempt nav timeout is deliberately long because the very first
  // login POST pays the server-function compile cost.
  await expect(async () => {
    await page.goto("/login");
    await page.locator("input").first().fill("founder@imblabs.example");
    await page.locator('input[type="password"]').fill("monarch-demo-2026");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("http://localhost:8082/", { timeout: 90_000 });
  }).toPass({ timeout: 240_000 });
  await expect(page.getByText("Executive Dashboard")).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
