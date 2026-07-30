/**
 * Integration test for GST slice 3 — reverse charge (RCM) and ITC eligibility.
 * Posts a ₹1,000 @ 18% purchase (₹180 GST) under each of the four combinations of
 * (reverse charge?) × (ITC eligible?) and checks the ledger:
 *
 *   forward + eligible   : AP -1180, Input GST +180, expense 1000, RCM 0
 *   forward + blocked    : AP -1180, Input GST 0,    expense 1180, RCM 0
 *   reverse + eligible   : AP -1000, Input GST +180, expense 1000, RCM -180
 *   reverse + blocked    : AP -1000, Input GST 0,    expense 1180, RCM -180
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-rcm.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import {
  accounts,
  billLines,
  bills,
  contacts,
  journalEntries,
  journalLines,
  organizations,
  taxRates,
} from "./schema";
import { createBill, postBill } from "@/server/bills";
import { stateCodeOf } from "@/lib/gst";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function main() {
  const orgs = await db
    .select({ id: organizations.id, gstin: organizations.taxRegistrationNumber })
    .from(organizations);
  const org = orgs.find((o) => stateCodeOf(o.gstin) !== null);
  if (!org) throw new Error("No GST-registered org — run db:seed first.");
  const orgId = org.id;

  const [rate] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(and(eq(taxRates.orgId, orgId), eq(taxRates.rateBps, 1800)))
      .limit(1),
  );
  const [vendor] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), inArray(contacts.type, ["vendor", "both"])))
      .limit(1),
  );
  if (!rate || !vendor) throw new Error("Need a GST 18% rate and a vendor.");

  // Resolve the accounts we assert on.
  const ap = await withOrg(orgId, (tx) =>
    tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          eq(accounts.subtype, "accounts_payable"),
          eq(accounts.isSystem, true),
        ),
      ),
  );
  const exp = await withOrg(orgId, (tx) =>
    tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          eq(accounts.subtype, "operating_expense"),
          eq(accounts.isSystem, true),
        ),
      ),
  );
  const gstAcc = await withOrg(orgId, (tx) =>
    tx
      .select({ code: accounts.code, id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          inArray(accounts.code, ["1140", "1141", "1142", "1143", "2205"]),
        ),
      ),
  );
  const apId = ap[0].id;
  const expId = exp[0].id;
  const byCode = new Map(gstAcc.map((a) => [a.code, a.id]));
  const inputIds = ["1140", "1141", "1142", "1143"].map((c) => byCode.get(c)!);
  const rcmId = byCode.get("2205")!;

  const madeBills: string[] = [];
  const madeEntries: string[] = [];

  async function purchase(reverseCharge: boolean, itcEligible: boolean) {
    const bill = await createBill({
      orgId,
      contactId: vendor.id,
      billDate: "2026-03-22",
      dueDate: "2026-04-22",
      reverseCharge,
      itcEligible,
      lines: [
        {
          description: "TEST RCM line",
          quantity: "1",
          unitPriceMinor: 100_000n,
          taxRateId: rate.id,
        },
      ],
    });
    const entry = await postBill({ orgId, billId: bill.billId });
    madeBills.push(bill.billId);
    madeEntries.push(entry.entryId);
    const lines = await withOrg(orgId, (tx) =>
      tx
        .select({ accountId: journalLines.accountId, amountMinor: journalLines.amountMinor })
        .from(journalLines)
        .where(eq(journalLines.entryId, entry.entryId)),
    );
    const on = (id: string) =>
      lines.filter((l) => l.accountId === id).reduce((s, l) => s + l.amountMinor, 0n);
    return {
      ap: on(apId),
      expense: on(expId),
      input: inputIds.reduce((s, id) => s + on(id), 0n),
      rcm: on(rcmId),
    };
  }

  try {
    const fe = await purchase(false, true);
    check(
      "forward+eligible: AP -1180, ITC +180, expense 1000, no RCM",
      fe.ap === -118_000n && fe.input === 18_000n && fe.expense === 100_000n && fe.rcm === 0n,
    );

    const fb = await purchase(false, false);
    check(
      "forward+blocked: AP -1180, no ITC, tax in expense (1180), no RCM",
      fb.ap === -118_000n && fb.input === 0n && fb.expense === 118_000n && fb.rcm === 0n,
    );

    const re = await purchase(true, true);
    check(
      "reverse+eligible: AP -1000 (ex-tax), ITC +180, expense 1000, RCM -180",
      re.ap === -100_000n && re.input === 18_000n && re.expense === 100_000n && re.rcm === -18_000n,
    );

    const rb = await purchase(true, false);
    check(
      "reverse+blocked: AP -1000, no ITC, tax in expense (1180), RCM -180",
      rb.ap === -100_000n && rb.input === 0n && rb.expense === 118_000n && rb.rcm === -18_000n,
    );
  } finally {
    await withOrg(orgId, async (tx) => {
      if (madeBills.length) {
        await tx.delete(billLines).where(inArray(billLines.billId, madeBills));
        await tx.delete(bills).where(inArray(bills.id, madeBills));
      }
      if (madeEntries.length) {
        await tx.delete(journalLines).where(inArray(journalLines.entryId, madeEntries));
        await tx.delete(journalEntries).where(inArray(journalEntries.id, madeEntries));
      }
    });
  }

  console.log(`\n${failures === 0 ? "All RCM checks passed." : `${failures} check(s) FAILED.`}`);
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
