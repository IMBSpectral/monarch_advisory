/**
 * Ledger integrity check.
 *
 * Proves the four properties the whole system rests on:
 *   1. every posted entry balances
 *   2. the trial balance's debits equal its credits
 *   3. assets == liabilities + equity (the accounting equation)
 *   4. cached invoice payment totals match their allocations
 *
 * Any failure here means the books are wrong, and every report derived from them
 * is wrong too. Worth wiring into CI.
 *
 * Run with:  bun run db:verify
 */

import { eq } from "drizzle-orm";
import { db, pgClient } from "./client";
import { organizations } from "./schema";
import { findUnbalancedEntries, verifyInvoiceBalances } from "@/server/ledger";
import {
  getBalanceSheet,
  getDashboardSummary,
  getProfitAndLoss,
  getReceivablesAging,
  getTrialBalance,
} from "@/server/reports";

const inr = (minor: bigint) => {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = (abs % 100n).toString().padStart(2, "0");
  const formatted = rupees.toLocaleString("en-IN");
  return `${negative ? "-" : ""}₹${formatted}.${paise}`;
};

const pad = (s: string, n: number) => s.padEnd(n);
const padStart = (s: string, n: number) => s.padStart(n);

let failures = 0;
function check(label: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organization found. Run `bun run db:seed` first.");

  const asOf = "2026-07-31";
  const from = "2026-04-01";

  console.log(`\nLedger verification — ${org.name}`);
  console.log(`Period ${from} → ${asOf}\n`);

  /* ── 1. Entry-level balance ────────────────────────────────────────────*/

  console.log("Integrity");
  const unbalanced = await findUnbalancedEntries(org.id);
  check(
    "every posted entry balances",
    unbalanced.length === 0,
    unbalanced.length ? `${unbalanced.length} unbalanced` : "0 unbalanced",
  );

  const drift = await verifyInvoiceBalances(org.id);
  check(
    "invoice paid amounts match allocations",
    drift.length === 0,
    drift.length ? `${drift.length} drifted` : "0 drifted",
  );

  /* ── 2. Trial balance ──────────────────────────────────────────────────*/

  const tb = await getTrialBalance(org.id, asOf);
  check(
    "trial balance: debits == credits",
    tb.isBalanced,
    `${inr(tb.totalDebitMinor)} vs ${inr(tb.totalCreditMinor)}`,
  );

  /* ── 3. Accounting equation ────────────────────────────────────────────*/

  const bs = await getBalanceSheet(org.id, asOf);
  check(
    "balance sheet: assets == liabilities + equity",
    bs.isBalanced,
    `${inr(bs.totalAssetsMinor)} vs ${inr(bs.totalLiabilitiesMinor + bs.totalEquityMinor)}`,
  );

  /* ── Reports ───────────────────────────────────────────────────────────*/

  console.log("\nTrial Balance");
  console.log(
    `  ${pad("Code", 6)}${pad("Account", 28)}${padStart("Debit", 18)}${padStart("Credit", 18)}`,
  );
  for (const r of tb.rows) {
    console.log(
      `  ${pad(r.code, 6)}${pad(r.name.slice(0, 26), 28)}` +
        `${padStart(r.debitMinor ? inr(r.debitMinor) : "", 18)}` +
        `${padStart(r.creditMinor ? inr(r.creditMinor) : "", 18)}`,
    );
  }
  console.log(
    `  ${pad("", 6)}${pad("TOTAL", 28)}${padStart(inr(tb.totalDebitMinor), 18)}${padStart(inr(tb.totalCreditMinor), 18)}`,
  );

  const pnl = await getProfitAndLoss(org.id, from, asOf);
  console.log("\nProfit & Loss");
  for (const r of pnl.revenue) {
    console.log(`  ${pad(r.name.slice(0, 34), 36)}${padStart(inr(r.amountMinor), 18)}`);
  }
  console.log(`  ${pad("Total Revenue", 36)}${padStart(inr(pnl.totalRevenueMinor), 18)}`);
  if (pnl.totalCogsMinor > 0n) {
    console.log(`  ${pad("Cost of Goods Sold", 36)}${padStart(inr(pnl.totalCogsMinor), 18)}`);
    console.log(`  ${pad("Gross Profit", 36)}${padStart(inr(pnl.grossProfitMinor), 18)}`);
  }
  for (const r of pnl.operatingExpenses) {
    console.log(`  ${pad(`  ${r.name}`.slice(0, 34), 36)}${padStart(inr(r.amountMinor), 18)}`);
  }
  console.log(
    `  ${pad("Total Operating Expenses", 36)}${padStart(inr(pnl.totalOperatingExpenseMinor), 18)}`,
  );
  console.log(`  ${pad("NET PROFIT", 36)}${padStart(inr(pnl.netProfitMinor), 18)}`);

  console.log("\nBalance Sheet");
  console.log("  Assets");
  for (const r of bs.assets) {
    console.log(`  ${pad(`  ${r.name}`.slice(0, 34), 36)}${padStart(inr(r.amountMinor), 18)}`);
  }
  console.log(`  ${pad("  Total Assets", 36)}${padStart(inr(bs.totalAssetsMinor), 18)}`);
  console.log("  Liabilities");
  for (const r of bs.liabilities) {
    console.log(`  ${pad(`  ${r.name}`.slice(0, 34), 36)}${padStart(inr(r.amountMinor), 18)}`);
  }
  console.log(`  ${pad("  Total Liabilities", 36)}${padStart(inr(bs.totalLiabilitiesMinor), 18)}`);
  console.log("  Equity");
  for (const r of bs.equity) {
    console.log(`  ${pad(`  ${r.name}`.slice(0, 34), 36)}${padStart(inr(r.amountMinor), 18)}`);
  }
  console.log(
    `  ${pad("  Retained Earnings (current)", 36)}${padStart(inr(bs.retainedEarningsMinor), 18)}`,
  );
  console.log(`  ${pad("  Total Equity", 36)}${padStart(inr(bs.totalEquityMinor), 18)}`);
  console.log(
    `  ${pad("  Liabilities + Equity", 36)}${padStart(inr(bs.totalLiabilitiesMinor + bs.totalEquityMinor), 18)}`,
  );

  const aging = await getReceivablesAging(org.id, asOf);
  console.log("\nA/R Aging");
  console.log(
    `  ${pad("Customer", 26)}${padStart("Current", 14)}${padStart("1-30", 14)}${padStart("31-60", 14)}${padStart("61-90", 12)}${padStart("90+", 12)}${padStart("Total", 14)}`,
  );
  for (const r of aging.rows) {
    console.log(
      `  ${pad(r.contactName.slice(0, 24), 26)}` +
        `${padStart(r.currentMinor ? inr(r.currentMinor) : "-", 14)}` +
        `${padStart(r.days1to30Minor ? inr(r.days1to30Minor) : "-", 14)}` +
        `${padStart(r.days31to60Minor ? inr(r.days31to60Minor) : "-", 14)}` +
        `${padStart(r.days61to90Minor ? inr(r.days61to90Minor) : "-", 12)}` +
        `${padStart(r.over90Minor ? inr(r.over90Minor) : "-", 12)}` +
        `${padStart(inr(r.totalMinor), 14)}`,
    );
  }
  console.log(
    `  ${pad("TOTAL", 26)}${padStart("", 66)}${padStart(inr(aging.totals.totalMinor), 14)}`,
  );

  /* ── Cross-check: AR control vs subledger ──────────────────────────────*/

  const arAccount = tb.rows.find((r) => r.subtype === "accounts_receivable");
  const arControl = arAccount ? arAccount.debitMinor - arAccount.creditMinor : 0n;
  console.log("");
  check(
    "A/R control account == aging subledger total",
    arControl === aging.totals.totalMinor,
    `control ${inr(arControl)} vs subledger ${inr(aging.totals.totalMinor)}`,
  );

  const dash = await getDashboardSummary(org.id, from, asOf);
  console.log("\nDashboard");
  console.log(`  ${pad("Cash & Bank", 28)}${padStart(inr(dash.cashMinor), 18)}`);
  console.log(`  ${pad("Receivables", 28)}${padStart(inr(dash.receivablesMinor), 18)}`);
  console.log(`  ${pad("Payables", 28)}${padStart(inr(dash.payablesMinor), 18)}`);
  console.log(`  ${pad("Revenue (period)", 28)}${padStart(inr(dash.revenueThisPeriodMinor), 18)}`);
  console.log(
    `  ${pad("Expenses (period)", 28)}${padStart(inr(dash.expensesThisPeriodMinor), 18)}`,
  );
  console.log(
    `  ${pad("Net Profit (period)", 28)}${padStart(inr(dash.netProfitThisPeriodMinor), 18)}`,
  );
  console.log(
    `  ${pad("Overdue Receivables", 28)}${padStart(inr(dash.overdueReceivablesMinor), 18)}`,
  );

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

main()
  .then(async (f) => {
    await pgClient.end();
    process.exit(f === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("\nVerification error:\n", err);
    await pgClient.end();
    process.exit(1);
  });
