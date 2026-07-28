import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Deep interaction coverage — drives the PRIMARY create / convert / post button
 * of every module that performs a real mutation, and asserts the success toast
 * plus a zero-console-error invariant. Complements monarch.spec.ts (which proves
 * every route renders and covers contra / journal / recurring / bank-import).
 *
 * Intentionally-inert controls are NOT asserted as mutations here (they only
 * fire toast.info): inventory "Scan", all of banking/connect + banking/review,
 * automation "New Workflow", warehouses (static), GST (CSV only). The
 * banking/reconcile page is a client-side simulation, exercised in its own file
 * if at all.
 *
 * Runs authenticated as the seeded owner (see auth.setup.ts), serially.
 */

/**
 * Wait for the toast whose text matches `re` and return it. Filtering by the
 * expected pattern (rather than taking the first toast) is essential because
 * sonner keeps a just-fired toast on screen for seconds — a create→act→read
 * sequence would otherwise read the stale create toast instead of the new one.
 */
async function waitToast(page: Page, re: RegExp): Promise<string> {
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: re }).first();
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  return (await toast.textContent()) ?? "";
}

/** Open a Radix Select trigger and pick an option by (accessible) name/regex. */
async function pick(page: Page, trigger: Locator, option: string | RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
}

/** The dialog currently on screen. */
function dialog(page: Page): Locator {
  return page.getByRole("dialog");
}

/**
 * Click a trigger and wait for its dialog. Retries the click because a button on
 * a just-loaded (server-rendered, not-yet-hydrated) page can swallow the first
 * click — relevant right after the signup redirect, before the client bundle
 * has wired up handlers.
 */
async function openDialog(page: Page, buttonName: string) {
  await expect(async () => {
    await page.getByRole("button", { name: buttonName }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Fail a test if any uncaught page error fires during it. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test.describe("sales — invoice lifecycle", () => {
  test("create & issue an invoice, then record full payment", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/sales/invoices");
    await page.getByRole("button", { name: "New Invoice" }).click();

    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), "Reliance Retail Ltd");
    await d.getByPlaceholder("Description").fill("QA services line");
    await d.getByPlaceholder("Unit ₹").fill("7500");
    await d.getByRole("checkbox", { name: /Issue immediately/ }).check();
    await d.getByRole("button", { name: "Create & issue" }).click();

    const created = await waitToast(page, /Invoice INV-[\d-]+ created and issued/);
    const number = created.match(/INV-[\d-]+/)?.[0] ?? "";

    // Open the invoice we just issued and pay it in full.
    await page.getByRole("link", { name: number }).first().click();
    await expect(page.getByRole("heading", { name: number })).toBeVisible();
    await page.getByRole("button", { name: "Record Payment" }).click();
    await dialog(page).getByRole("button", { name: "Record payment" }).click();
    await waitToast(page, /Payment recorded against INV-/);
    await expect(page.getByText("Fully paid.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("create a draft invoice (no ledger impact)", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/sales/invoices");
    await page.getByRole("button", { name: "New Invoice" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), "Tata Digital");
    await d.getByPlaceholder("Description").fill("Draft only");
    await d.getByPlaceholder("Unit ₹").fill("1000");
    await d.getByRole("button", { name: "Create draft" }).click();
    await waitToast(page, /Draft invoice INV-[\d-]+ created/);
    expect(errors).toEqual([]);
  });
});

test.describe("sales — contacts & documents", () => {
  test("create a customer", async ({ page }) => {
    await page.goto("/sales/customers");
    await page.getByRole("button", { name: "New Customer" }).click();
    await dialog(page)
      .getByLabel("Name")
      .fill(`QA Customer ${Date.now() % 100000}`);
    await dialog(page).getByRole("button", { name: "Create customer" }).click();
    await waitToast(page, /Customer created/);
  });

  test("create a sales order and convert it to an invoice", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/sales/orders");
    await page.getByRole("button", { name: "New Sales Order" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), "BigBasket");
    await pick(page, d.getByRole("combobox").nth(1), "Monarch Mechanical Keyboard");
    await d.getByRole("button", { name: "Create order" }).click();
    const created = await waitToast(page, /Sales order SO-[\d-]+ created/);

    const number = created.match(/SO-[\d-]+/)?.[0] ?? "";
    const row = page.getByRole("row", { hasText: number });
    await row.getByRole("button", { name: "Convert to invoice" }).first().click();
    await waitToast(page, /Invoice INV-[\d-]+ created & posted/);
    expect(errors).toEqual([]);
  });

  test("dispatch a delivery note (stock out)", async ({ page }) => {
    await page.goto("/sales/deliveries");
    await page.getByRole("button", { name: "New Delivery Note" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), "BigBasket");
    await pick(page, d.getByRole("combobox").nth(1), "USB-C Hub 8-in-1");
    await d.getByRole("button", { name: "Dispatch stock" }).click();
    await waitToast(page, /Delivery DC-[\d-]+ posted \(stock out\)/);
  });

  test("post a credit note against an invoice", async ({ page }) => {
    await page.goto("/sales/credit-notes");
    await page.getByRole("button", { name: "New Credit Note" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), /INV-/);
    await d.getByPlaceholder("Description").fill("Goodwill credit");
    await d.getByPlaceholder("Unit ₹").fill("500");
    await d.getByRole("button", { name: "Post credit note" }).click();
    await waitToast(page, /Credit note CN-[\d-]+ posted/);
  });

  test("create a recurring template", async ({ page }) => {
    await page.goto("/sales/recurring");
    await page.getByRole("button", { name: "New Template" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), "Zomato Ltd");
    await d.getByPlaceholder("Monthly retainer").fill(`QA retainer ${Date.now() % 100000}`);
    await pick(page, d.getByRole("combobox").nth(2), "Monarch Mechanical Keyboard");
    await d.getByRole("button", { name: "Create template" }).click();
    await waitToast(page, /Recurring template .* created/);
  });
});

test.describe("purchases", () => {
  test("create a vendor", async ({ page }) => {
    await page.goto("/purchases/vendors");
    await page.getByRole("button", { name: "New Vendor" }).click();
    await dialog(page)
      .getByLabel("Vendor name")
      .fill(`QA Vendor ${Date.now() % 100000}`);
    await dialog(page).getByRole("button", { name: "Create vendor" }).click();
    await waitToast(page, /Vendor created/);
  });

  test("record & post an expense bill", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/purchases/bills");
    await page.getByRole("button", { name: "New Bill" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), /.+/); // first vendor
    await d.getByPlaceholder("Description").fill("Office supplies");
    await d.getByPlaceholder("Unit ₹").fill("3200");
    await d.getByRole("checkbox", { name: /Approve & post/ }).check();
    await d.getByRole("button", { name: "Record & post" }).click();
    await waitToast(page, /Bill BILL-[\d-]+ recorded and posted/);
    expect(errors).toEqual([]);
  });

  test("create a purchase order and convert it to a bill", async ({ page }) => {
    await page.goto("/purchases/orders");
    await page.getByRole("button", { name: "New Purchase Order" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), /.+/);
    await pick(page, d.getByRole("combobox").nth(1), "Standing Desk 60x30");
    await d.getByRole("button", { name: "Create order" }).click();
    const created = await waitToast(page, /Purchase order PO-[\d-]+ created/);

    const number = created.match(/PO-[\d-]+/)?.[0] ?? "";
    const row = page.getByRole("row", { hasText: number });
    await row.getByRole("button", { name: "Convert to bill" }).first().click();
    await waitToast(page, /Bill BILL-[\d-]+ created & posted/);
  });

  test("receive goods (stock in) and raise the bill", async ({ page }) => {
    await page.goto("/purchases/grn");
    await page.getByRole("button", { name: "New Goods Receipt" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), /.+/);
    await pick(page, d.getByRole("combobox").nth(1), "USB-C Hub 8-in-1");
    await d.getByPlaceholder("Unit ₹").fill("900");
    await d.getByRole("button", { name: "Receive stock" }).click();
    const created = await waitToast(page, /Goods receipt GRN-[\d-]+ posted \(stock in\)/);

    const number = created.match(/GRN-[\d-]+/)?.[0] ?? "";
    const row = page.getByRole("row", { hasText: number });
    await row.getByRole("button", { name: "Raise bill" }).first().click();
    await waitToast(page, /Bill BILL-[\d-]+ created \(GRNI cleared\)/);
  });

  test("post a debit note against a bill", async ({ page }) => {
    await page.goto("/purchases/debit-notes");
    await page.getByRole("button", { name: "New Debit Note" }).click();
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), /BILL-/);
    await d.getByPlaceholder("Description").fill("Defective returns");
    await d.getByPlaceholder("Unit ₹").fill("400");
    await d.getByRole("button", { name: "Post debit note" }).click();
    await waitToast(page, /Debit note DN-[\d-]+ posted/);
  });
});

test.describe("inventory — item master CRUD", () => {
  const itemName = `QA Item ${Date.now() % 100000}`;

  test("blank name is rejected inline (no silent failure)", async ({ page }) => {
    await page.goto("/inventory");
    await page.getByRole("button", { name: "New Item" }).click();
    await dialog(page).getByRole("button", { name: "Create item" }).click();
    await expect(dialog(page).getByText("Item name is required.")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
  });

  test("create, edit, then archive an item", async ({ page }) => {
    await page.goto("/inventory");
    // Create
    await page.getByRole("button", { name: "New Item" }).click();
    await dialog(page).getByLabel("Name").fill(itemName);
    await dialog(page).getByLabel("Sale price (₹)").fill("999");
    await dialog(page).getByRole("button", { name: "Create item" }).click();
    await waitToast(page, /Item created/);
    await expect(page.getByText(itemName)).toBeVisible();

    // Edit
    await page.getByRole("button", { name: `Actions for ${itemName}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await dialog(page).getByLabel("Sale price (₹)").fill("1499");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await waitToast(page, /Item updated/);

    // Archive
    await page.getByRole("button", { name: `Actions for ${itemName}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
    await waitToast(page, new RegExp(`${itemName.replace(/[()]/g, "\\$&")} archived`));
    await expect(page.getByText(itemName)).toHaveCount(0);
  });
});

test.describe("point of sale", () => {
  test("add an item to the cart and charge it", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/pos");
    await page.getByText("USB-C Hub 8-in-1").first().click();
    await page.getByRole("button", { name: /^Charge / }).click();
    await waitToast(page, /Sale complete — INV-[\d-]+/);
    expect(errors).toEqual([]);
  });
});

test.describe("accounting", () => {
  test("create a cost centre", async ({ page }) => {
    await page.goto("/accounting/cost-centers");
    await page.getByRole("button", { name: "New Cost Centre" }).click();
    const code = `Q${Date.now() % 10000}`;
    await dialog(page).getByLabel("Code").fill(code);
    await dialog(page).getByLabel("Name").fill("QA Cost Centre");
    await dialog(page).getByRole("button", { name: "Create" }).click();
    await waitToast(page, /Cost centre .* created/);
  });

  test("register a fixed asset, then run depreciation", async ({ page }) => {
    await page.goto("/accounting/fixed-assets");
    await page.getByRole("button", { name: "New Asset" }).click();
    const d = dialog(page);
    await d.getByPlaceholder("FA-001").fill(`FA-Q${Date.now() % 10000}`);
    await d.getByRole("textbox").nth(1).fill("QA Test Rig");
    await pick(page, d.getByRole("combobox").first(), /.+/); // asset account
    await d.getByRole("spinbutton").first().fill("120000"); // cost
    await d.getByRole("button", { name: "Register asset" }).click();
    await waitToast(page, /Asset .* registered/);

    await page.getByRole("button", { name: "Run depreciation" }).click();
    await waitToast(page, /Posted \d+ depreciation charge|Nothing new to depreciate/);
  });

  test("save an exchange rate", async ({ page }) => {
    await page.goto("/accounting/exchange-rates");
    await page.getByRole("button", { name: "Add Rate" }).click();
    await dialog(page).getByPlaceholder("USD").fill("EUR");
    await dialog(page).getByPlaceholder("83.50").fill("91.25");
    await dialog(page).getByRole("button", { name: "Save rate" }).click();
    await waitToast(page, /EUR rate saved/);
  });

  test("period-close controls are wired and validate their input", async ({ page }) => {
    // The full close→reopen ledger flow is a stateful mutation of a watermark
    // that only ever moves forward, so asserting it against a shared DB is not
    // idempotent (repeatedly closing the same date sticks the watermark). It is
    // verified end-to-end manually and by the ledger tests; here we prove the
    // Close button is wired and rejects a missing date without touching the
    // ledger — a deterministic, non-destructive check.
    await page.goto("/accounting/period-close");
    await expect(page.getByText("Books closed through")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(/Choose a date to close through\./);
  });
});

test.describe("crm", () => {
  test("capture a lead (stored as a customer contact)", async ({ page }) => {
    await page.goto("/crm");
    await page.getByRole("button", { name: "New Lead" }).click();
    await dialog(page)
      .getByLabel("Name")
      .fill(`QA Lead ${Date.now() % 100000}`);
    await dialog(page).getByRole("button", { name: "Create lead" }).click();
    await waitToast(page, /Lead saved as customer contact/);
  });
});

test.describe("settings — team management", () => {
  test("invite a member", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Invite member" }).click();
    const d = dialog(page);
    const email = `qa+${Date.now() % 1000000}@imblabs.example`;
    await d.getByLabel("Name").fill("QA Teammate");
    await d.getByLabel("Email").fill(email);
    await d.getByLabel("Initial password").fill("changeme-123");
    await d.getByRole("button", { name: "Send invite" }).click();
    await waitToast(page, /Member added/);
    await expect(page.getByText(email)).toBeVisible();
  });
});

test.describe("signup — a brand-new org gets working books", () => {
  // Sign up runs unauthenticated, so drop the shared owner session for this block.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("register an org, then create & issue an invoice in it", async ({ page }) => {
    const errors = trackErrors(page);
    const stamp = `${Date.now()}`.slice(-9);
    await page.goto("/signup");
    await page.getByLabel("Organization name").fill(`E2E Org ${stamp} Ltd`);
    await page.getByLabel("Your name").fill("E2E Founder");
    await page.getByLabel("Email").fill(`e2e-signup-${stamp}@example.test`);
    await page.getByLabel("Password").fill(`signup-secret-${stamp}`);
    await page.getByRole("button", { name: "Create organization" }).click();
    await page.waitForURL("http://localhost:8082/");

    // The org is provisioned with a chart of accounts + document sequences, so
    // a customer + issued invoice must post cleanly (control accounts resolve,
    // INV sequence starts at 1) — this is what was impossible before signup
    // provisioning existed.
    await page.goto("/sales/customers");
    await openDialog(page, "New Customer");
    await dialog(page).getByLabel("Name").fill("First Client Co");
    await dialog(page).getByRole("button", { name: "Create customer" }).click();
    await waitToast(page, /Customer created/);

    await page.goto("/sales/invoices");
    await openDialog(page, "New Invoice");
    const d = dialog(page);
    await pick(page, d.getByRole("combobox").first(), "First Client Co");
    await d.getByPlaceholder("Description").fill("First engagement");
    await d.getByPlaceholder("Unit ₹").fill("25000");
    await d.getByRole("checkbox", { name: /Issue immediately/ }).check();
    await d.getByRole("button", { name: "Create & issue" }).click();
    await waitToast(page, /Invoice INV-0001 created and issued/);
    expect(errors).toEqual([]);
  });

  test("a fresh org has GST rates and can create accounts + bank accounts", async ({ page }) => {
    const stamp = `${Date.now()}`.slice(-9);
    await page.goto("/signup");
    await page.getByLabel("Organization name").fill(`E2E Setup ${stamp} Ltd`);
    await page.getByLabel("Your name").fill("E2E Founder");
    await page.getByLabel("Email").fill(`e2e-setup-${stamp}@example.test`);
    await page.getByLabel("Password").fill(`signup-secret-${stamp}`);
    await page.getByRole("button", { name: "Create organization" }).click();
    await page.waitForURL("http://localhost:8082/");

    // GST rates are provisioned, so a line's tax dropdown offers real rates.
    await page.goto("/sales/customers");
    await openDialog(page, "New Customer");
    await dialog(page).getByLabel("Name").fill("Taxable Client");
    await dialog(page).getByRole("button", { name: "Create customer" }).click();
    await waitToast(page, /Customer created/);
    await page.goto("/sales/invoices");
    await openDialog(page, "New Invoice");
    await dialog(page).getByRole("combobox").filter({ hasText: "No tax" }).click();
    await expect(page.getByRole("option", { name: "GST 18%", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    // Admin can add a ledger account…
    await page.goto("/accounting/coa");
    await openDialog(page, "New account");
    await dialog(page).getByLabel("Name").fill("Consulting Income");
    await dialog(page).getByRole("button", { name: "Create account" }).click();
    await waitToast(page, /Account created/);
    await expect(page.getByText("Consulting Income")).toBeVisible();

    // …and add a bank/cash account manually (no feed).
    await page.goto("/banking");
    await openDialog(page, "Add account");
    await dialog(page).getByLabel("Name", { exact: true }).fill("Main Current");
    await dialog(page).getByRole("button", { name: "Add account" }).click();
    await waitToast(page, /Account added/);
    await expect(page.getByText("Main Current")).toBeVisible();
  });
});

test.describe("reports — custom date range", () => {
  test("P&L: a preset scopes the period and updates the URL + header", async ({ page }) => {
    await page.goto("/accounting/pnl");
    await page.getByRole("button", { name: /This Financial Year:/ }).click();
    await page.getByRole("button", { name: "Last Month", exact: true }).click();
    await expect(page).toHaveURL(/preset=last_month&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}/);
    // Header echoes the same window the report was computed for.
    const to = new URL(page.url()).searchParams.get("to")!;
    await expect(page.getByText(`For period ${to.slice(0, 7)}`, { exact: false })).toBeVisible();
  });

  test("P&L: a custom range validates Start ≤ End then applies", async ({ page }) => {
    await page.goto("/accounting/pnl");
    await page.getByRole("button", { name: /This Financial Year:/ }).click();
    // Inverted range: error shows and Apply is disabled.
    await page.locator("#rp-start").fill("2026-07-25");
    await page.locator("#rp-end").fill("2026-07-20");
    await expect(page.getByText("Start date must be on or before the end date.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    // Fix it and apply.
    await page.locator("#rp-start").fill("2026-07-10");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/preset=custom&from=2026-07-10&to=2026-07-20/);
  });

  test("Balance Sheet: a preset sets the as-of end date only", async ({ page }) => {
    await page.goto("/accounting/balance-sheet");
    await page.getByRole("button", { name: /This Financial Year:/ }).click();
    await page.getByRole("button", { name: "Last Month", exact: true }).click();
    // Point-in-time: asOf is last month's END, and there is no from/to.
    await expect(page).toHaveURL(/preset=last_month&asOf=\d{4}-\d{2}-\d{2}/);
    await expect(page).not.toHaveURL(/from=/);
    const asOf = new URL(page.url()).searchParams.get("asOf")!;
    await expect(page.getByText(`As of ${asOf}`).first()).toBeVisible();
  });

  test("GST: a preset scopes the return period from the ledger", async ({ page }) => {
    await page.goto("/accounting/gst");
    await page.getByRole("button", { name: /This Financial Year:/ }).click();
    await page.getByRole("button", { name: "This Month", exact: true }).click();
    await expect(page).toHaveURL(/preset=this_month&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}/);
    // Summary card and net-payable line reflect the chosen period.
    const to = new URL(page.url()).searchParams.get("to")!;
    await expect(
      page.getByRole("heading", { name: new RegExp(`GST Summary.*${to}`) }),
    ).toBeVisible();
    await expect(page.getByText("Net GST Payable")).toBeVisible();
  });
});

test.describe("header — global search & create menu", () => {
  test("global search returns and routes to a customer", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Search invoices, items, customers…").fill("BigBasket");
    const result = page.getByRole("button", { name: /BigBasket customer/i });
    await expect(result).toBeVisible();
    await result.click();
    await expect(page).toHaveURL(/\/sales\/customers/);
  });

  test("create menu routes to the bill screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Bill" }).click();
    await expect(page).toHaveURL(/\/purchases\/bills/);
  });
});
