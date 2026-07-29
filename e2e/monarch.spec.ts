import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end coverage of every module built across Phases 1–8, plus interaction
 * tests for the marquee flows. Runs authenticated (see auth.setup.ts).
 */

// Every route the app exposes, with a heading/text that proves it rendered.
const ROUTES: [string, string][] = [
  ["/", "Executive Dashboard"],
  ["/accounting/coa", "Chart of Accounts"],
  ["/accounting/journal", "Journal Entries"],
  ["/accounting/contra", "Contra Vouchers"],
  ["/accounting/cost-centers", "Cost Centres"],
  ["/accounting/fixed-assets", "Fixed Assets"],
  ["/accounting/exchange-rates", "Exchange Rates"],
  ["/accounting/period-close", "Period Close"],
  ["/accounting/pnl", "Profit & Loss"],
  ["/accounting/balance-sheet", "Balance Sheet"],
  ["/accounting/gst", "GST Returns"],
  ["/sales/invoices", "Invoices"],
  ["/sales/orders", "Sales Orders"],
  ["/sales/deliveries", "Delivery Notes"],
  ["/sales/recurring", "Recurring Invoices"],
  ["/sales/credit-notes", "Credit Notes"],
  ["/sales/customers", "Customers"],
  ["/purchases/bills", "Bills"],
  ["/purchases/orders", "Purchase Orders"],
  ["/purchases/grn", "Goods Receipts"],
  ["/purchases/debit-notes", "Debit Notes"],
  ["/purchases/vendors", "Vendors"],
  ["/inventory", "Inventory"],
  ["/pos", "Point of Sale"],
  ["/banking", "Banking"],
  ["/banking/import", "Import Bank Statement"],
  ["/reports", "Reports"],
  ["/reports/payables-aging", "Payables Aging"],
  ["/reports/cash-flow", "Cash Flow Statement"],
  ["/reports/day-book", "Day Book"],
  ["/reports/stock", "Stock Summary"],
  ["/reports/trial-balance", "Trial Balance"],
  ["/reports/ratios", "Financial Ratios"],
  ["/reports/monthly-pnl", "Monthly P&L"],
  ["/reports/cost-center-pnl", "Cost-Centre P&L"],
  ["/reports/budget", "Budget vs Actual"],
  ["/reports/forex", "Forex Revaluation"],
  ["/reports/consolidation", "Group Consolidation"],
];

test.describe("smoke — every module renders with real data", () => {
  for (const [path, text] of ROUTES) {
    test(`renders ${path}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(path);
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
      // Must not have bounced to the login screen (session/route guard broken).
      await expect(page).not.toHaveURL(/\/login/);
      expect(errors, `uncaught errors on ${path}`).toEqual([]);
    });
  }
});

test.describe("key figures are present and non-empty", () => {
  test("balance sheet shows Balanced and inventory asset", async ({ page }) => {
    await page.goto("/accounting/balance-sheet");
    await expect(page.getByText("Balanced").first()).toBeVisible();
    await expect(page.getByText("Inventory").first()).toBeVisible();
  });

  test("cash flow reconciles", async ({ page }) => {
    await page.goto("/reports/cash-flow");
    await expect(page.getByText("Reconciled").first()).toBeVisible();
  });

  test("bank reconciliation screen renders the feed-vs-book summary", async ({ page }) => {
    await page.goto("/banking/reconcile");
    await expect(page.getByRole("heading", { name: "Reconcile", exact: true })).toBeVisible();
    // A seeded org has bank accounts, so the reconciliation summary appears.
    await expect(page.getByText("Bank feed balance").first()).toBeVisible();
    await expect(page.getByText("Book (GL) balance").first()).toBeVisible();
  });

  test("approval queue renders (empty when approvals are off)", async ({ page }) => {
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible();
    await expect(page.getByText("Nothing waiting for approval")).toBeVisible();
  });

  test("CSV import screen parses a pasted file into a preview", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import Data" })).toBeVisible();
    await page
      .getByPlaceholder(/name,type,email/)
      .fill("name,type,email\nPreview Co,customer,p@x.com");
    // The parsed row shows up in the preview table.
    await expect(page.getByRole("cell", { name: "Preview Co" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Import 1 row/ })).toBeVisible();
  });

  test("forex exposure shows the USD account", async ({ page }) => {
    await page.goto("/reports/forex");
    await expect(page.getByText("SVB USD Account").first()).toBeVisible();
  });

  test("consolidation shows both entities", async ({ page }) => {
    await page.goto("/reports/consolidation");
    await expect(page.getByText("IMB Labs LLP").first()).toBeVisible();
    await expect(page.getByText("Sentinel Foods").first()).toBeVisible();
  });
});

async function toastText(page: Page): Promise<string> {
  const toast = page.locator("[data-sonner-toast], li[role='status']").first();
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  return (await toast.textContent()) ?? "";
}

test.describe("interactions — the new voucher flows actually post", () => {
  test("record a contra transfer", async ({ page }) => {
    await page.goto("/accounting/contra");
    await page.getByRole("button", { name: "New Transfer" }).click();
    // From / To selects (Radix): open and pick.
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /HDFC/ }).click();
    await page.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: /Petty Cash/ }).click();
    await page.getByLabel(/Amount/).fill("12345");
    await page.getByRole("button", { name: "Record transfer" }).click();
    expect(await toastText(page)).toMatch(/Contra .* recorded/i);
  });

  test("post a balanced manual journal entry", async ({ page }) => {
    await page.goto("/accounting/journal");
    await page.getByRole("button", { name: "New Entry" }).click();
    // Line 1: debit an account 100.
    await page.getByRole("combobox").nth(0).click();
    await page.getByRole("option").first().click();
    await page.getByPlaceholder("₹").nth(0).fill("100");
    // Line 2 (each line has 3 selects: account, side, cost centre → line 2 starts at index 3).
    await page.getByRole("combobox").nth(3).click(); // 2nd line account select
    await page.getByRole("option").nth(1).click();
    await page.getByRole("combobox").nth(4).click(); // 2nd line side
    await page.getByRole("option", { name: "Credit" }).click();
    await page.getByPlaceholder("₹").nth(1).fill("100");
    await expect(page.getByText("Balanced")).toBeVisible();
    await page.getByRole("button", { name: "Post entry" }).click();
    expect(await toastText(page)).toMatch(/Journal entry .* posted/i);
  });

  test("generate due recurring invoices", async ({ page }) => {
    await page.goto("/sales/recurring");
    await page.getByRole("button", { name: "Generate due" }).click();
    expect(await toastText(page)).toMatch(/Generated \d+ invoice|Nothing due/i);
  });

  test("import a bank statement", async ({ page }) => {
    await page.goto("/banking/import");
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /HDFC/ }).click();
    await page.getByRole("button", { name: "Load sample" }).click();
    await page.getByRole("button", { name: /Import/ }).click();
    expect(await toastText(page)).toMatch(/Imported \d+ transaction/i);
  });
});
